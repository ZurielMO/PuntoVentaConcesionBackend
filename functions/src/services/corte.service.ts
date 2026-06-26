import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.CORTES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export const listCortes = async () => {
  const snap = await col().get();
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
  ventaId: string | undefined,
  idUser: string | undefined,
  data: {
    fecha: string;
    comentarios?: string;
    estatus: string;
    totalReal: number;
    totalCaja: number;
  },
) => {
  const payload = {
    ventaId: ventaId ?? null,
    idUser: idUser ?? null,
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
