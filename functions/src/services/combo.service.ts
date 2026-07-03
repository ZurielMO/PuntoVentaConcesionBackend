import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { ComboProducto } from "../models";

const col = () => firestorePos.collection(COLLECTIONS.COMBOS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

const assertConcessionExists = async (concesionId: string) => {
  const doc = await firestorePos
    .collection(COLLECTIONS.CONCESIONES)
    .doc(concesionId)
    .get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }
};

/** Valida que todos los productos existan y pertenezcan a la concesión. */
const assertProductosDeConcesion = async (
  concesionId: string,
  productoIds: string[],
) => {
  const unique = [...new Set(productoIds)];
  const docs = await Promise.all(
    unique.map((id) => firestorePos.collection(COLLECTIONS.PRODUCTS).doc(id).get()),
  );
  for (const doc of docs) {
    if (!doc.exists || doc.data()?.activo === false) {
      throw new ApiError(
        400,
        `El producto ${doc.id} no existe o está inactivo`,
        true,
        "INVALID_PRODUCT",
      );
    }
    if (doc.data()?.concesion_id !== concesionId) {
      throw new ApiError(
        400,
        `El producto ${doc.id} no pertenece a la concesión`,
        true,
        "INVALID_PRODUCT",
      );
    }
  }
};

export interface ComboInput {
  titulo: string;
  descripcion?: string | null;
  productos: ComboProducto[];
  precio: number;
  activo?: boolean;
}

export const listCombos = async (filters?: {
  concesionId?: string;
  includeInactive?: boolean;
}) => {
  let query: FirebaseFirestore.Query = col();
  if (!filters?.includeInactive) {
    query = query.where("activo", "==", true);
  }
  if (filters?.concesionId) {
    query = query.where("concesion_id", "==", filters.concesionId);
  }
  const snap = await query.get();
  return snap.docs.map(toData);
};

export const getComboById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Combo no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createCombo = async (
  concesionId: string,
  data: ComboInput,
  createdBy?: { uid?: string | null; nombre?: string | null },
) => {
  await assertConcessionExists(concesionId);
  await assertProductosDeConcesion(
    concesionId,
    data.productos.map((p) => p.producto_id),
  );

  const payload = {
    concesion_id: concesionId,
    titulo: data.titulo,
    descripcion: data.descripcion ?? null,
    productos: data.productos,
    precio: data.precio,
    activo: data.activo ?? true,
    createdByUid: createdBy?.uid ?? null,
    createdByNombre: createdBy?.nombre ?? null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const updateCombo = async (id: string, data: Partial<ComboInput>) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Combo no encontrado", true, "NOT_FOUND");
  }

  // No se permite cambiar la concesión; los productos se validan contra ella.
  if (data.productos) {
    const concesionId = doc.data()?.concesion_id as string;
    await assertProductosDeConcesion(
      concesionId,
      data.productos.map((p) => p.producto_id),
    );
  }

  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return toData(updated);
};

export const softDeleteCombo = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Combo no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
};

/** Eliminación física del documento en Firestore. */
export const hardDeleteCombo = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Combo no encontrado", true, "NOT_FOUND");
  }
  await ref.delete();
};
