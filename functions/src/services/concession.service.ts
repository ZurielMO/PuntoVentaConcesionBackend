import axios from "axios";
import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { buildOriginId } from "../utils/origin-id.util";
import { normalizeRecordImageUrls } from "./storage.service";

const col = () => firestorePos.collection(COLLECTIONS.CONCESIONES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> & { id: string } =>
  normalizeRecordImageUrls({
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

/**
 * Resuelve solo el nombre de una concesión sin exigir superadmin ni lanzar.
 * Pensado para enriquecer el perfil POS (auth/me, login) del vendedor.
 */
export const getConcessionNombre = async (
  id?: string | null,
): Promise<string | null> => {
  if (!id) return null;
  try {
    const doc = await col().doc(id).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    // El modelo actual usa `nombre`; se aceptan alias legados por robustez.
    const candidates = [
      data.nombre,
      data.nombreComercial,
      data.razonSocial,
      data.name,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
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
// assignUserToConcession: Actualizar usuario admin de una concesión
// y sincronizar el campo concesionId en el documento del usuario
// ---------------------------------------------------------------------------

export const assignUserToConcession = async (
  concessionId: string,
  userId: string,
) => {
  const concRef = col().doc(concessionId);
  const concDoc = await concRef.get();
  if (!concDoc.exists) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }

  // Verificar que el usuario existe y es ADMIN
  const userCol = firestorePos.collection(COLLECTIONS.USERS);
  const userRef = userCol.doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  const userData = userDoc.data();
  const rol = typeof userData?.rol === "string" ? userData.rol.toUpperCase() : undefined;
  if (rol !== "ADMIN") {
    throw new ApiError(
      400,
      "Solo se pueden asignar usuarios con rol ADMIN a una concesión",
      true,
      "INVALID_USER_ROLE",
    );
  }

  // Actualizar la concesión
  await concRef.update({
    idUser: userId,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Actualizar el usuario con la concesión
  await userRef.update({
    concesionId: concessionId,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await concRef.get();
  return toData(updated);
};

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

export const appendConcessionImages = async (
  id: string,
  newUrls: string[],
) => {
  const concession = await getConcessionById(id);
  const imagenes = [...((concession.imagenes as string[] | undefined) ?? []), ...newUrls];
  const ref = col().doc(id);
  await ref.update({
    imagenes,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const updated = await ref.get();
  return toData(updated);
};

export const removeConcessionImageAtIndex = async (id: string, index: number) => {
  const concession = await getConcessionById(id);
  const imagenes = [...((concession.imagenes as string[] | undefined) ?? [])];
  if (index < 0 || index >= imagenes.length) {
    throw new ApiError(404, "Imagen no encontrada", true, "NOT_FOUND");
  }
  const removedUrl = imagenes[index];
  imagenes.splice(index, 1);
  const ref = col().doc(id);
  await ref.update({
    imagenes,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const updated = await ref.get();
  return { updated: toData(updated), removedUrl };
};
