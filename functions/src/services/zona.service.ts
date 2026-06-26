import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.ZONAS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export const listZonas = async () => {
  const snap = await col().where("activo", "==", true).get();
  return snap.docs.map(toData);
};

export const getZonaById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Zona no encontrada", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createZona = async (data: { zona: string; activo?: boolean }) => {
  const payload = {
    zona: data.zona,
    activo: data.activo ?? true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const updateZona = async (
  id: string,
  data: Partial<{ zona: string; activo: boolean }>,
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Zona no encontrada", true, "NOT_FOUND");
  }
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return toData(updated);
};

export const softDeleteZona = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Zona no encontrada", true, "NOT_FOUND");
  }
  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
};
