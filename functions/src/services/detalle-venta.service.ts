import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.COMPROBANTES_VENTA);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

interface DetalleProducto {
  producto: string;
  cantidad: number;
  precio_actual: number;
}

const computeLineas = (productos: DetalleProducto[]) =>
  productos.map((p) => ({
    producto: p.producto,
    cantidad: p.cantidad,
    precio_actual: p.precio_actual,
    subtotal: Math.round(p.cantidad * p.precio_actual * 100) / 100,
  }));

const computeTotal = (lineas: { subtotal: number }[]) =>
  Math.round(lineas.reduce((acc, l) => acc + l.subtotal, 0) * 100) / 100;

export const createDetalleVenta = async (params: {
  ventaId: string;
  concesionId: string;
  sucursalId: string;
  inventarioId: string;
  productos: DetalleProducto[];
}) => {
  const lineas = computeLineas(params.productos);
  const total = computeTotal(lineas);

  const ref = col().doc();
  await ref.set({
    ventaId: params.ventaId,
    concesionId: params.concesionId,
    sucursalId: params.sucursalId,
    inventarioId: params.inventarioId,
    total,
    fecha: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const batch = firestorePos.batch();
  const detalleRef = ref.collection(SUBCOLLECTIONS.DETALLE);
  for (const linea of lineas) {
    batch.set(detalleRef.doc(), linea);
  }
  await batch.commit();

  return getDetalleVentaById(ref.id);
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

export const updateDetalleVenta = async (
  id: string,
  productos: DetalleProducto[],
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Comprobante no encontrado", true, "NOT_FOUND");
  }

  const lineas = computeLineas(productos);
  const total = computeTotal(lineas);

  // Reemplazar el detalle existente.
  const detalleRef = ref.collection(SUBCOLLECTIONS.DETALLE);
  const existing = await detalleRef.get();
  const batch = firestorePos.batch();
  existing.docs.forEach((d) => batch.delete(d.ref));
  lineas.forEach((linea) => batch.set(detalleRef.doc(), linea));
  batch.update(ref, { total, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  return getDetalleVentaById(id);
};
