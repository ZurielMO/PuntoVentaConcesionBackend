import axios from "axios";
import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { buildOriginId } from "../utils/origin-id.util";

const col = () => firestorePos.collection(COLLECTIONS.CONCESIONES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export const listConcessions = async () => {
  const snap = await col().where("activo", "==", true).get();
  return snap.docs.map(toData);
};

export const getConcessionById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createConcession = async (
  data: { nombre: string; activo?: boolean; imagenes?: string[] },
  idUser?: string,
) => {
  const payload = {
    nombre: data.nombre,
    activo: data.activo ?? true,
    imagenes: data.imagenes ?? [],
    idUser: idUser ?? null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const replaceConcession = async (
  id: string,
  data: { nombre: string; activo?: boolean; imagenes?: string[] },
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }

  // Replace completo limpiando campos legacy: mantenemos solo el modelo actual.
  const existing = doc.data() ?? {};
  await ref.set({
    nombre: data.nombre,
    activo: data.activo ?? true,
    imagenes: data.imagenes ?? [],
    idUser: existing.idUser ?? null,
    createdAt: existing.createdAt ?? FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await ref.get();
  return toData(updated);
};

export const softDeleteConcession = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }
  await ref.update({
    activo: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
};

// ---------------------------------------------------------------------------
// asignarPuntosConsecion (typo intencional, confirmado en producción)
// ---------------------------------------------------------------------------

export interface AssignConcessionPointsParams {
  userId: string;
  total: number;
  descripcion: string;
}

const calcularPuntos = (total: number): number => {
  const diezPorciento = Math.round(total * 0.1 * 100) / 100;
  return Number.isInteger(diezPorciento)
    ? diezPorciento
    : Math.ceil(diezPorciento);
};

export const assignConcessionPoints = async (
  params: AssignConcessionPointsParams,
) => {
  const { userId, total, descripcion } = params;

  const puntosAsignados = calcularPuntos(total);

  const sistema = process.env.CONCESSION_POINTS_SOURCE_SYSTEM || "backendcl";
  const idOrigen = buildOriginId({ sistema, userId, total });

  const baseUrl =
    process.env.CONCESSION_POINTS_ASSIGN_URL ||
    "https://us-central1-e-comerce-leon.cloudfunctions.net/api/api/usuarios";
  const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(
    userId,
  )}/puntos/asignar`;

  let externalResponse: unknown = null;

  try {
    const resp = await axios.post(
      url,
      { points: puntosAsignados, descripcion, origenId: idOrigen },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 },
    );
    externalResponse = resp.data;
  } catch (error) {
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;

    // Si el externo rechaza descripcion/origenId con 400, reintentar con {points}.
    if (status === 400) {
      try {
        const retry = await axios.post(
          url,
          { points: puntosAsignados },
          { headers: { "Content-Type": "application/json" }, timeout: 15000 },
        );
        externalResponse = retry.data;
      } catch (retryError) {
        throw new ApiError(
          502,
          "No se pudieron asignar los puntos en el sistema externo",
          true,
          "EXTERNAL_POINTS_FAILED",
        );
      }
    } else {
      throw new ApiError(
        502,
        "No se pudieron asignar los puntos en el sistema externo",
        true,
        "EXTERNAL_POINTS_FAILED",
      );
    }
  }

  return {
    usuarioId: userId,
    total,
    puntosAsignados,
    descripcion,
    idOrigen,
    externalResponse,
  };
};
