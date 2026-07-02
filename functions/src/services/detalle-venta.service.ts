import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { logMovimientoInTransaction } from "./inventario.service";

const col = () => firestorePos.collection(COLLECTIONS.COMPROBANTES_VENTA);
const inventariosCol = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);
const productsCol = () => firestorePos.collection(COLLECTIONS.PRODUCTS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

interface DetalleProductoInput {
  producto: string;
  cantidad: number;
  precio_actual?: number;
}

interface ResolvedLinea {
  producto: string;
  cantidad: number;
  precio_actual: number;
  subtotal: number;
}

const computeTotal = (lineas: { subtotal: number }[]) =>
  Math.round(lineas.reduce((acc, l) => acc + l.subtotal, 0) * 100) / 100;

const resolvePrecio = (
  inputPrice: number | undefined,
  invProducto: FirebaseFirestore.DocumentData | undefined,
  catalogProduct: FirebaseFirestore.DocumentData | undefined,
): number => {
  if (invProducto?.precio_jornada != null) {
    return Number(invProducto.precio_jornada);
  }
  if (catalogProduct?.precio != null) {
    return Number(catalogProduct.precio);
  }
  if (inputPrice != null) {
    return Number(inputPrice);
  }
  throw new ApiError(
    400,
    "No se pudo determinar el precio del producto",
    true,
    "INVALID_PRICE",
  );
};

const resolveLineas = async (
  inventarioId: string,
  productos: DetalleProductoInput[],
): Promise<ResolvedLinea[]> => {
  const lineas: ResolvedLinea[] = [];

  for (const item of productos) {
    const invProdDoc = await inventariosCol()
      .doc(inventarioId)
      .collection(SUBCOLLECTIONS.PRODUCTOS)
      .doc(item.producto)
      .get();

    const catalogDoc = await productsCol().doc(item.producto).get();
    const precio = resolvePrecio(
      item.precio_actual,
      invProdDoc.data(),
      catalogDoc.data(),
    );

    lineas.push({
      producto: item.producto,
      cantidad: item.cantidad,
      precio_actual: precio,
      subtotal: Math.round(item.cantidad * precio * 100) / 100,
    });
  }

  return lineas;
};

export const createDetalleVenta = async (params: {
  ventaId: string;
  concesionId: string;
  sucursalId: string;
  inventarioId: string;
  idUser?: string;
  productos: DetalleProductoInput[];
}) => {
  const lineas = await resolveLineas(params.inventarioId, params.productos);
  const total = computeTotal(lineas);

  const comprobanteRef = col().doc();
  const inventarioRef = inventariosCol().doc(params.inventarioId);

  await firestorePos.runTransaction(async (tx) => {
    const invDoc = await tx.get(inventarioRef);
    if (!invDoc.exists || invDoc.data()?.activo === false) {
      throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
    }

    for (const linea of lineas) {
      const prodRef = inventarioRef.collection(SUBCOLLECTIONS.PRODUCTOS).doc(linea.producto);
      const prodDoc = await tx.get(prodRef);
      if (!prodDoc.exists) {
        throw new ApiError(
          400,
          `Producto ${linea.producto} no está en el inventario`,
          true,
          "PRODUCT_NOT_IN_INVENTORY",
        );
      }

      const data = prodDoc.data() ?? {};
      const cantidadInicial = Number(data.cantidad_inicial ?? 0);
      const cantidadFinal = Number(data.cantidad_final ?? cantidadInicial);
      const disponible = cantidadFinal;

      if (linea.cantidad > disponible) {
        throw new ApiError(
          409,
          `Stock insuficiente para el producto ${linea.producto}`,
          true,
          "INSUFFICIENT_STOCK",
        );
      }

      const nuevaCantidad = cantidadFinal - linea.cantidad;

      tx.set(
        prodRef,
        {
          cantidad_final: nuevaCantidad,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      logMovimientoInTransaction(tx, params.inventarioId, {
        tipo: "VENTA",
        producto_id: linea.producto,
        cantidad: -linea.cantidad,
        cantidad_anterior: cantidadFinal,
        cantidad_nueva: nuevaCantidad,
        sucursal_id: params.sucursalId,
        idUser: params.idUser ?? null,
        ventaId: params.ventaId,
      });
    }

    tx.set(comprobanteRef, {
      ventaId: params.ventaId,
      concesionId: params.concesionId,
      sucursalId: params.sucursalId,
      inventarioId: params.inventarioId,
      idUser: params.idUser ?? null,
      total,
      fecha: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const detalleRef = comprobanteRef.collection(SUBCOLLECTIONS.DETALLE);
    lineas.forEach((linea) => {
      tx.set(detalleRef.doc(), linea);
    });
  });

  return getDetalleVentaById(comprobanteRef.id);
};

export const getDetalleVentaById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Comprobante no encontrado", true, "NOT_FOUND");
  }
  const detalleSnap = await col()
    .doc(id)
    .collection(SUBCOLLECTIONS.DETALLE)
    .get();
  return { ...toData(doc), detalle: detalleSnap.docs.map(toData) };
};

export const listDetalleVentas = async (filters: {
  concesionId?: string;
  sucursalId?: string;
  idUser?: string;
}) => {
  let query: FirebaseFirestore.Query = col();
  if (filters.concesionId) {
    query = query.where("concesionId", "==", filters.concesionId);
  }
  if (filters.sucursalId) {
    query = query.where("sucursalId", "==", filters.sucursalId);
  }
  if (filters.idUser) {
    query = query.where("idUser", "==", filters.idUser);
  }
  const snap = await query.get();
  return snap.docs.map(toData);
};

export const updateDetalleVenta = async (
  id: string,
  productos: DetalleProductoInput[],
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Comprobante no encontrado", true, "NOT_FOUND");
  }

  const inventarioId = doc.data()?.inventarioId as string;
  const lineas = await resolveLineas(inventarioId, productos);
  const total = computeTotal(lineas);

  const detalleRef = ref.collection(SUBCOLLECTIONS.DETALLE);
  const existing = await detalleRef.get();
  const batch = firestorePos.batch();
  existing.docs.forEach((d) => batch.delete(d.ref));
  lineas.forEach((linea) => batch.set(detalleRef.doc(), linea));
  batch.update(ref, { total, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  return getDetalleVentaById(id);
};
