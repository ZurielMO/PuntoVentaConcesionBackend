import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.CORTES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export interface CorteListFilters {
  concesionId?: string;
  sucursalId?: string;
  idUser?: string;
}

export const listCortes = async (filters: CorteListFilters = {}) => {
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

export const getCorteById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createCorte = async (
  context: {
    concesionId: string;
    sucursalId?: string | null;
    idUser: string;
    ventaId?: string | null;
  },
  data: {
    fecha: string;
    comentarios?: string;
    estatus: string;
    totalReal: number;
    totalCaja: number;
  },
) => {
  const payload = {
    ventaId: context.ventaId ?? null,
    idUser: context.idUser,
    concesionId: context.concesionId,
    sucursalId: context.sucursalId ?? null,
    fecha: data.fecha,
    comentarios: data.comentarios ?? null,
    estatus: data.estatus,
    totalReal: data.totalReal,
    totalCaja: data.totalCaja,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const updateCorte = async (
  id: string,
  data: Partial<{
    fecha: string;
    comentarios: string;
    estatus: string;
    totalReal: number;
    totalCaja: number;
  }>,
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return toData(updated);
};
