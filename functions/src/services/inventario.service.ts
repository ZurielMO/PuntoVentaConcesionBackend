import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

/** Normaliza fecha a YYYY-MM-DD (acepta YYYY-MM-DD o DD/MM/YYYY). */
export const normalizeFecha = (fecha: string): string => {
  const raw = decodeURIComponent(fecha).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  }
  throw new ApiError(
    400,
    "Formato de fecha inválido (usa YYYY-MM-DD o DD/MM/YYYY)",
    true,
    "INVALID_DATE",
  );
};

/** Construye el ID compuesto: `2026-03-14__J11__sucursalId`. */
export const buildInventarioId = (
  fecha: string,
  jornadaNumero: string | number,
  sucursalId: string,
): string => `${normalizeFecha(fecha)}__J${jornadaNumero}__${sucursalId}`;

const productosCol = (inventarioId: string) =>
  col().doc(inventarioId).collection(SUBCOLLECTIONS.PRODUCTOS);

export const listInventarios = async (includeProductos: boolean) => {
  const snap = await col().where("activo", "==", true).get();
  const inventarios = snap.docs.map(toData);

  if (!includeProductos) {
    return inventarios;
  }

  return Promise.all(
    inventarios.map(async (inv) => {
      const prodSnap = await productosCol(inv.id).get();
      return { ...inv, productos: prodSnap.docs.map(toData) };
    }),
  );
};

export const getInventarioById = async (
  id: string,
  includeProductos: boolean,
) => {
  const doc = await col().doc(id).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const inv = toData(doc);
  if (!includeProductos) {
    return inv;
  }
  const prodSnap = await productosCol(id).get();
  return { ...inv, productos: prodSnap.docs.map(toData) };
};

export const createInventario = async (
  jornadaNumero: string,
  fechaJornada: string,
  sucursalId: string,
) => {
  const fecha = normalizeFecha(fechaJornada);
  const id = buildInventarioId(fecha, jornadaNumero, sucursalId);
  const ref = col().doc(id);

  const existing = await ref.get();
  if (existing.exists && existing.data()?.activo !== false) {
    throw new ApiError(
      409,
      "Ya existe un inventario para esa jornada/fecha/sucursal",
      true,
      "DUPLICATE_INVENTARIO",
    );
  }

  await ref.set({
    jornada_fecha: fecha,
    jornada_numero: Number(jornadaNumero),
    sucursal_id: sucursalId,
    activo: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const doc = await ref.get();
  return toData(doc);
};

export const softDeleteInventario = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
};

// --- Productos del inventario ---

export const listInventarioProductos = async (inventarioId: string) => {
  const doc = await col().doc(inventarioId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const snap = await productosCol(inventarioId).get();
  return snap.docs.map(toData);
};

export const getInventarioProducto = async (
  inventarioId: string,
  productoId: string,
) => {
  const doc = await productosCol(inventarioId).doc(productoId).get();
  if (!doc.exists) {
    throw new ApiError(
      404,
      "Producto de inventario no encontrado",
      true,
      "NOT_FOUND",
    );
  }
  return toData(doc);
};

export const upsertInventarioProducto = async (
  inventarioId: string,
  productoId: string,
  data: Partial<{
    producto_id: string;
    cantidad_inicial: number;
    cantidad_final: number;
    precio_jornada: number;
  }>,
) => {
  const invDoc = await col().doc(inventarioId).get();
  if (!invDoc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }

  const ref = productosCol(inventarioId).doc(productoId);
  await ref.set(
    {
      producto_id: data.producto_id ?? productoId,
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const doc = await ref.get();
  return toData(doc);
};

export const deleteInventarioProducto = async (
  inventarioId: string,
  productoId: string,
) => {
  const ref = productosCol(inventarioId).doc(productoId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(
      404,
      "Producto de inventario no encontrado",
      true,
      "NOT_FOUND",
    );
  }
  await ref.delete();
};
