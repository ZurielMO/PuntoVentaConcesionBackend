import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { logMovimientoInTransaction } from "./inventario.service";
import {
  buildJornadaId,
  resolveCajaActivaParaVendedor,
} from "./asignacion-caja.service";
import { getUserById } from "./user.service";

const col = () => firestorePos.collection(COLLECTIONS.COMPROBANTES_VENTA);
const inventariosCol = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);
const productsCol = () => firestorePos.collection(COLLECTIONS.PRODUCTS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> & { id: string } => ({
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

const resolveCajaForVenta = async (params: {
  idUser: string;
  sucursalId: string;
  inventarioId: string;
}) => {
  const invDoc = await inventariosCol().doc(params.inventarioId).get();
  if (!invDoc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const inv = invDoc.data() ?? {};
  const jornadaId = buildJornadaId(
    String(inv.jornada_fecha ?? ""),
    Number(inv.jornada_numero ?? 0),
  );

  let fallbackCajaId: string | null = null;
  let cajeroNombre = "Cajero";
  try {
    const profile = await getUserById(params.idUser);
    fallbackCajaId = (profile.cajaId as string | null | undefined) ?? null;
    cajeroNombre = (profile.nombre as string) ?? cajeroNombre;
  } catch {
    // Perfil opcional si uid no está en users
  }

  const caja = await resolveCajaActivaParaVendedor({
    vendedorUid: params.idUser,
    jornadaId,
    sucursalId: params.sucursalId,
    fallbackCajaId,
  });

  if (!caja) {
    throw new ApiError(
      400,
      "Debes tener una caja asignada para registrar ventas",
      true,
      "MISSING_CAJA",
    );
  }

  return { jornadaId, caja, cajeroNombre };
};

export const createDetalleVenta = async (params: {
  ventaId: string;
  concesionId: string;
  sucursalId: string;
  inventarioId: string;
  idUser?: string;
  productos: DetalleProductoInput[];
}) => {
  if (!params.idUser) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }

  const { jornadaId, caja, cajeroNombre } = await resolveCajaForVenta({
    idUser: params.idUser,
    sucursalId: params.sucursalId,
    inventarioId: params.inventarioId,
  });

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
        cajaId: caja.cajaId,
        cajaNombre: caja.cajaNombre,
        idUser: params.idUser ?? null,
        ventaId: params.ventaId,
      });
    }

    tx.set(comprobanteRef, {
      ventaId: params.ventaId,
      concesionId: params.concesionId,
      sucursalId: params.sucursalId,
      inventarioId: params.inventarioId,
      jornadaId,
      cajaId: caja.cajaId,
      cajaNombre: caja.cajaNombre,
      idUser: params.idUser ?? null,
      cajeroNombre,
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
  cajaId?: string;
  inventarioId?: string;
}) => {
  let query: FirebaseFirestore.Query = col();
  if (filters.concesionId) {
    query = query.where("concesionId", "==", filters.concesionId);
  } else if (filters.inventarioId) {
    query = query.where("inventarioId", "==", filters.inventarioId);
  }

  const snap = await query.get();
  let results = snap.docs.map(toData);

  if (filters.inventarioId && filters.concesionId) {
    results = results.filter((r) => r.inventarioId === filters.inventarioId);
  }
  if (filters.sucursalId) {
    results = results.filter((r) => r.sucursalId === filters.sucursalId);
  }
  if (filters.cajaId) {
    results = results.filter((r) => r.cajaId === filters.cajaId);
  }
  if (filters.idUser) {
    results = results.filter((r) => r.idUser === filters.idUser);
  }

  results.sort((a, b) => {
    const ta = (a.fecha as { _seconds?: number })?._seconds
      ?? (a.createdAt as { _seconds?: number })?._seconds
      ?? 0;
    const tb = (b.fecha as { _seconds?: number })?._seconds
      ?? (b.createdAt as { _seconds?: number })?._seconds
      ?? 0;
    return tb - ta;
  });

  return results;
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

export const resolveCajaContextForUser = resolveCajaForVenta;
