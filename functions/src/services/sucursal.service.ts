import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.SUCURSALES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

const getCajasOf = async (sucursalId: string) => {
  const snap = await col()
    .doc(sucursalId)
    .collection(SUBCOLLECTIONS.CAJAS)
    .get();
  return snap.docs.map(toData);
};

export const listSucursales = async () => {
  const snap = await col().where("activo", "==", true).get();
  return snap.docs.map(toData);
};

export const getSucursalById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  const cajas = await getCajasOf(id);
  return { ...toData(doc), cajas };
};

export const getCajas = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  return getCajasOf(id);
};

const setCajas = async (sucursalId: string, cajas: string[]) => {
  const batch = firestorePos.batch();
  const cajasRef = col().doc(sucursalId).collection(SUBCOLLECTIONS.CAJAS);
  for (const nombre of cajas) {
    batch.set(cajasRef.doc(nombre), { activo: true }, { merge: true });
  }
  await batch.commit();
};

export const createSucursal = async (
  concesionId: string,
  zonaId: string,
  data: { activo?: boolean; sucursal: { nombre?: string; cajas?: string[] } },
) => {
  const payload = {
    concesion_id: concesionId,
    zona_id: zonaId,
    nombre: data.sucursal.nombre ?? null,
    activo: data.activo ?? true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);

  const cajas = data.sucursal.cajas ?? [];
  if (cajas.length > 0) {
    await setCajas(ref.id, cajas);
  }

  return getSucursalById(ref.id);
};

export const updateSucursal = async (
  id: string,
  data: {
    activo?: boolean;
    zona_id?: string;
    sucursal?: { nombre?: string; cajas?: string[] };
  },
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }

  // No se permite cambiar concesion_id.
  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (data.activo !== undefined) update.activo = data.activo;
  if (data.zona_id !== undefined) update.zona_id = data.zona_id;
  if (data.sucursal?.nombre !== undefined) update.nombre = data.sucursal.nombre;

  await ref.update(update);

  if (data.sucursal?.cajas) {
    await setCajas(id, data.sucursal.cajas);
  }

  return getSucursalById(id);
};

export const softDeleteSucursal = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
};
