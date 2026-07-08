import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { firestoreApp, USUARIOS_APP_COLLECTION } from "../config/app.firebase";
import { ApiError } from "../utils/api-error";
import {
  canAddAsTrabajadorClub,
  getEffectiveRoles,
  isTrabajadorClub,
  ROL_CLIENTE,
  ROL_TRABAJADOR_CLUBLEON,
} from "../utils/usuario-roles";
import {
  deleteCortesiasForUsuario,
  getCortesiasResumen,
  listCortesiasByUsuarioRef,
  mapCortesiaDoc,
  syncCortesiasForUsuario,
  updateCortesiaCanjeadaDoc,
  type CortesiaTrabajadorClubDoc,
} from "./cortesias-trabajador-club.service";

const usuariosCol = () => firestoreApp.collection(USUARIOS_APP_COLLECTION);

const SENSITIVE_FIELDS = new Set([
  "password",
  "stripeCustomerId",
  "historialPuntos",
  "solicitudEliminacion",
]);

export type TrabajadorClubPreview = {
  id: string;
  uid: string;
  nombre: string;
  email: string;
  telefono?: string | null;
  rol: string;
  roles: string[];
  provider?: string;
  activo: boolean;
  puntosActuales?: number;
  nivel?: string | null;
  esTrabajadorClub: boolean;
  puedeAgregar: boolean;
  motivoNoAgregar?: string;
};

export type TrabajadorClub = {
  id: string;
  uid: string;
  nombre: string;
  email: string;
  telefono?: string | null;
  roles: string[];
  cortesiasTotal: number;
  cortesiasCanjeadas: number;
  trabajadorClubAgregadoAt?: string | null;
  trabajadorClubAgregadoPor?: string | null;
  activo: boolean;
  puntosActuales?: number;
  nivel?: string | null;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const timestampToIso = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (
    typeof value === "object" &&
    value !== null &&
    "_seconds" in value &&
    typeof (value as { _seconds: number })._seconds === "number"
  ) {
    return new Date((value as { _seconds: number })._seconds * 1000).toISOString();
  }
  return null;
};

const stripSensitive = (data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    if (!SENSITIVE_FIELDS.has(key)) {
      out[key] = val;
    }
  }
  return out;
};

const docToPreview = (
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): TrabajadorClubPreview => {
  const raw = doc.data() as Record<string, unknown>;
  const safe = stripSensitive(raw);
  const usuario = {
    rol: safe.rol as string | undefined,
    roles: safe.roles as string[] | undefined,
    activo: safe.activo !== false,
  };
  const eligibility = canAddAsTrabajadorClub(usuario);
  const roles = getEffectiveRoles(usuario);

  return {
    id: doc.id,
    uid: String(safe.uid ?? ""),
    nombre: String(safe.nombre ?? ""),
    email: String(safe.email ?? ""),
    telefono: (safe.telefono as string | null | undefined) ?? null,
    rol: String(safe.rol ?? ""),
    roles,
    provider: safe.provider as string | undefined,
    activo: safe.activo !== false,
    puntosActuales:
      typeof safe.puntosActuales === "number" ? safe.puntosActuales : undefined,
    nivel: (safe.nivel as string | null | undefined) ?? null,
    esTrabajadorClub: isTrabajadorClub(usuario),
    puedeAgregar: eligibility.ok,
    motivoNoAgregar: eligibility.ok ? undefined : eligibility.message,
  };
};

const docToTrabajador = async (
  doc: FirebaseFirestore.DocumentSnapshot,
): Promise<TrabajadorClub> => {
  const raw = doc.data() as Record<string, unknown>;
  const safe = stripSensitive(raw);
  const usuario = {
    rol: safe.rol as string | undefined,
    roles: safe.roles as string[] | undefined,
  };
  const resumen = await getCortesiasResumen(doc.ref);

  return {
    id: doc.id,
    uid: String(safe.uid ?? ""),
    nombre: String(safe.nombre ?? ""),
    email: String(safe.email ?? ""),
    telefono: (safe.telefono as string | null | undefined) ?? null,
    roles: getEffectiveRoles(usuario),
    cortesiasTotal: resumen.cortesiasTotal,
    cortesiasCanjeadas: resumen.cortesiasCanjeadas,
    trabajadorClubAgregadoAt: timestampToIso(safe.trabajadorClubAgregadoAt),
    trabajadorClubAgregadoPor:
      (safe.trabajadorClubAgregadoPor as string | null | undefined) ?? null,
    activo: safe.activo !== false,
    puntosActuales:
      typeof safe.puntosActuales === "number" ? safe.puntosActuales : undefined,
    nivel: (safe.nivel as string | null | undefined) ?? null,
  };
};

const findUsuarioDocByEmail = async (email: string) => {
  const normalized = normalizeEmail(email);
  const snap = await usuariosCol()
    .where("email", "==", normalized)
    .limit(1)
    .get();
  if (!snap.empty) return snap.docs[0];

  const snapOriginal = await usuariosCol()
    .where("email", "==", email.trim())
    .limit(1)
    .get();
  if (!snapOriginal.empty) return snapOriginal.docs[0];
  return null;
};

const findUsuarioDocByUid = async (uid: string) => {
  const snap = await usuariosCol().where("uid", "==", uid).limit(1).get();
  if (!snap.empty) return snap.docs[0];
  return null;
};

const assertTrabajadorDoc = async (uid: string) => {
  const doc = await findUsuarioDocByUid(uid);
  if (!doc) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }
  const data = doc.data() as Record<string, unknown>;
  const usuario = {
    rol: data.rol as string | undefined,
    roles: data.roles as string[] | undefined,
  };
  if (!isTrabajadorClub(usuario)) {
    throw new ApiError(
      404,
      "El usuario no es trabajador del club",
      true,
      "NOT_TRABAJADOR",
    );
  }
  return doc;
};

export const searchUsuarioByEmail = async (
  email: string,
): Promise<TrabajadorClubPreview> => {
  if (!email?.trim()) {
    throw new ApiError(400, "El correo es requerido", true, "MISSING_EMAIL");
  }

  const doc = await findUsuarioDocByEmail(email);
  if (!doc) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  return docToPreview(doc);
};

export const listTrabajadoresClub = async (options?: {
  limit?: number;
}): Promise<TrabajadorClub[]> => {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);

  const snap = await usuariosCol()
    .where("roles", "array-contains", ROL_TRABAJADOR_CLUBLEON)
    .limit(limit)
    .get();

  return Promise.all(snap.docs.map((doc) => docToTrabajador(doc)));
};

export const addTrabajadorClub = async (
  input: { uid?: string; email?: string },
  addedByUid: string,
): Promise<TrabajadorClub> => {
  const doc =
    input.uid != null
      ? await findUsuarioDocByUid(input.uid)
      : input.email != null
        ? await findUsuarioDocByEmail(input.email)
        : null;

  if (!doc) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  const docRef = doc.ref;

  await firestoreApp.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) {
      throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
    }

    const data = fresh.data() as Record<string, unknown>;
    const usuario = {
      rol: data.rol as string | undefined,
      roles: data.roles as string[] | undefined,
      activo: data.activo !== false,
    };

    const eligibility = canAddAsTrabajadorClub(usuario);
    if (!eligibility.ok) {
      const status = eligibility.code === "ALREADY_TRABAJADOR" ? 409 : 403;
      throw new ApiError(status, eligibility.message, true, eligibility.code);
    }

    const currentRoles = getEffectiveRoles(usuario);
    const nextRoles = currentRoles.includes(ROL_TRABAJADOR_CLUBLEON)
      ? currentRoles
      : [...currentRoles, ROL_TRABAJADOR_CLUBLEON];

    if (!nextRoles.includes(ROL_CLIENTE)) {
      nextRoles.unshift(ROL_CLIENTE);
    }

    tx.update(docRef, {
      roles: nextRoles,
      rol: data.rol ?? ROL_CLIENTE,
      trabajadorClubAgregadoAt: FieldValue.serverTimestamp(),
      trabajadorClubAgregadoPor: addedByUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await syncCortesiasForUsuario(docRef);

  const updated = await docRef.get();
  if (!updated.exists) {
    throw new ApiError(500, "Error al leer trabajador actualizado", true, "INTERNAL");
  }
  return docToTrabajador(updated);
};

export const listCortesiasTrabajador = async (
  uid: string,
): Promise<CortesiaTrabajadorClubDoc[]> => {
  const doc = await assertTrabajadorDoc(uid);
  return listCortesiasByUsuarioRef(doc.ref);
};

export const updateCortesiaCanjeada = async (
  uid: string,
  cortesiaId: string,
  cortesiaCanjeada: boolean,
): Promise<CortesiaTrabajadorClubDoc> => {
  const doc = await assertTrabajadorDoc(uid);
  try {
    return await updateCortesiaCanjeadaDoc(doc.ref, cortesiaId, cortesiaCanjeada);
  } catch {
    throw new ApiError(404, "Cortesía no encontrada", true, "NOT_FOUND");
  }
};

export const removeTrabajadorClub = async (uid: string): Promise<void> => {
  const doc = await assertTrabajadorDoc(uid);

  const data = doc.data() as Record<string, unknown>;
  const usuario = {
    rol: data.rol as string | undefined,
    roles: data.roles as string[] | undefined,
  };

  const nextRoles = getEffectiveRoles(usuario).filter(
    (r) => r !== ROL_TRABAJADOR_CLUBLEON,
  );

  await deleteCortesiasForUsuario(doc.ref);

  await doc.ref.update({
    roles: nextRoles.length > 0 ? nextRoles : [ROL_CLIENTE],
    updatedAt: FieldValue.serverTimestamp(),
  });
};

export { mapCortesiaDoc, type CortesiaTrabajadorClubDoc };
