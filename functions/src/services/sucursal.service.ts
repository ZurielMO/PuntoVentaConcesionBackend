import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.SUCURSALES);

/** Máximo de cajas por sucursal (activas + desactivadas). */
export const MAX_CAJAS_POR_SUCURSAL = 3;

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

const normalizeCaja = (doc: FirebaseFirestore.DocumentSnapshot) => {
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    nombre: (data.nombre as string | undefined) ?? doc.id,
    activo: data.activo !== false,
    orden: Number(data.orden ?? 0),
    ...data,
  };
};

const assertSucursalExists = async (sucursalId: string) => {
  const doc = await col().doc(sucursalId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  return doc;
};

const assertSucursalActive = async (sucursalId: string) => {
  const doc = await assertSucursalExists(sucursalId);
  if (doc.data()?.activo === false) {
    throw new ApiError(400, "La sucursal está desactivada", true, "SUCURSAL_INACTIVE");
  }
  return doc;
};

const getCajasOf = async (sucursalId: string, includeInactive = false) => {
  const snap = await col()
    .doc(sucursalId)
    .collection(SUBCOLLECTIONS.CAJAS)
    .get();
  const cajas = snap.docs.map(normalizeCaja);
  if (includeInactive) return cajas;
  return cajas.filter((c) => c.activo !== false);
};

export const listSucursales = async (concesionId?: string) => {
  // Incluye desactivadas para administración (estado y reactivación en UI).
  let query: FirebaseFirestore.Query = col();
  if (concesionId) {
    query = query.where("concesion_id", "==", concesionId);
  }
  const snap = await query.get();
  const sucursales = await Promise.all(
    snap.docs.map(async (doc) => {
      const cajas = await getCajasOf(doc.id, true);
      return { ...toData(doc), cajas };
    }),
  );
  return sucursales;
};

export const getSucursalById = async (id: string) => {
  await assertSucursalExists(id);
  const doc = await col().doc(id).get();
  const cajas = await getCajasOf(id, true);
  return { ...toData(doc), cajas };
};

export const getCajas = async (id: string, includeInactive = false) => {
  await assertSucursalExists(id);
  return getCajasOf(id, includeInactive);
};

export const getCajaById = async (sucursalId: string, cajaId: string) => {
  await assertSucursalExists(sucursalId);
  const doc = await col()
    .doc(sucursalId)
    .collection(SUBCOLLECTIONS.CAJAS)
    .doc(cajaId)
    .get();
  if (!doc.exists) {
    throw new ApiError(404, "Caja no encontrada", true, "NOT_FOUND");
  }
  return normalizeCaja(doc);
};

export const assertCajaBelongsToSucursal = async (
  sucursalId: string,
  cajaId: string,
) => {
  await assertSucursalActive(sucursalId);
  const caja = await getCajaById(sucursalId, cajaId);
  if (caja.activo === false) {
    throw new ApiError(400, "La caja está inactiva", true, "CAJA_INACTIVE");
  }
  return caja;
};

export const createCaja = async (
  sucursalId: string,
  data: { nombre: string; orden?: number },
) => {
  await assertSucursalActive(sucursalId);
  const existentes = await getCajasOf(sucursalId, true);
  if (existentes.length >= MAX_CAJAS_POR_SUCURSAL) {
    throw new ApiError(
      400,
      `Máximo ${MAX_CAJAS_POR_SUCURSAL} cajas por sucursal`,
      true,
      "MAX_CAJAS",
    );
  }
  const ref = col().doc(sucursalId).collection(SUBCOLLECTIONS.CAJAS).doc();
  const payload = {
    nombre: data.nombre.trim(),
    activo: true,
    orden: data.orden ?? 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(payload);
  const created = await ref.get();
  return normalizeCaja(created);
};

export const updateCaja = async (
  sucursalId: string,
  cajaId: string,
  data: { nombre?: string; activo?: boolean; orden?: number },
) => {
  await getCajaById(sucursalId, cajaId);
  const ref = col().doc(sucursalId).collection(SUBCOLLECTIONS.CAJAS).doc(cajaId);
  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (data.nombre !== undefined) update.nombre = data.nombre.trim();
  if (data.activo !== undefined) update.activo = data.activo;
  if (data.orden !== undefined) update.orden = data.orden;
  await ref.update(update);
  const updated = await ref.get();
  return normalizeCaja(updated);
};

export const softDeleteCaja = async (sucursalId: string, cajaId: string) => {
  return updateCaja(sucursalId, cajaId, { activo: false });
};

/** Compat legacy: crea cajas por nombre al crear sucursal (doc id = nombre). */
const setCajasLegacy = async (sucursalId: string, cajas: string[]) => {
  const existentes = await getCajasOf(sucursalId, true);
  const nombresNuevos = cajas.map((n) => n.trim()).filter(Boolean);
  const idsExistentes = new Set(existentes.map((c) => c.id));
  const aCrear = nombresNuevos.filter((n) => !idsExistentes.has(n));
  if (existentes.length + aCrear.length > MAX_CAJAS_POR_SUCURSAL) {
    throw new ApiError(
      400,
      `Máximo ${MAX_CAJAS_POR_SUCURSAL} cajas por sucursal`,
      true,
      "MAX_CAJAS",
    );
  }
  const batch = firestorePos.batch();
  const cajasRef = col().doc(sucursalId).collection(SUBCOLLECTIONS.CAJAS);
  for (const nombre of cajas) {
    const trimmed = nombre.trim();
    if (!trimmed) continue;
    batch.set(
      cajasRef.doc(trimmed),
      {
        nombre: trimmed,
        activo: true,
        orden: 0,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
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
    await setCajasLegacy(ref.id, cajas);
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

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (data.activo !== undefined) update.activo = data.activo;
  if (data.zona_id !== undefined) update.zona_id = data.zona_id;
  if (data.sucursal?.nombre !== undefined) update.nombre = data.sucursal.nombre;

  await ref.update(update);

  if (data.sucursal?.cajas) {
    await setCajasLegacy(id, data.sucursal.cajas);
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
