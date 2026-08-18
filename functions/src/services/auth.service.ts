import axios from "axios";
import jwt from "jsonwebtoken";
import {
  authAppOficial,
  firestoreApp,
  hasAppOficialCredentials,
  USUARIOS_APP_COLLECTION,
} from "../config/app.firebase";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { UserRole } from "../models";
import { ApiError } from "../utils/api-error";
import {
  isPosEligibleUser,
  toConcesionRole,
  toInternalRole,
} from "../utils/concesion-roles";
import { getConcessionNombre } from "./concession.service";
import * as sucursalService from "./sucursal.service";

const usuariosCol = () => firestoreApp.collection(USUARIOS_APP_COLLECTION);
const legacyUsersCol = () => firestorePos.collection(COLLECTIONS.USERS);

const getFirebaseApiKey = (): string => {
  const key =
    process.env.FIREBASE_API_KEY ||
    process.env.CLIENT_FIREBASE_API_KEY ||
    process.env.AUTH_API_KEY ||
    process.env.WEB_API_KEY ||
    process.env.FIREBASE_WEB_API_KEY ||
    "";
  if (!key) {
    throw new ApiError(
      500,
      "Login por contraseña no configurado (falta FIREBASE_API_KEY de app-oficial-leon)",
      false,
      "AUTH_NOT_CONFIGURED",
    );
  }
  return key;
};

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new ApiError(
      500,
      "JWT_SECRET no está definido (debe coincidir con BackendCL)",
      false,
      "AUTH_NOT_CONFIGURED",
    );
  }
  return secret;
};

export type UsuariosAppProfile = {
  id: string;
  uid: string;
  email?: string;
  nombre?: string;
  rol?: string;
  activo?: boolean;
  from_concesion?: boolean;
  concesionId?: string | null;
  sucursalId?: string | null;
  cajaId?: string | null;
  fechaNacimiento?: unknown;
  fecha_nacimiento?: string;
  [key: string]: unknown;
};

const mapAppOficialFirestoreError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  if (/PERMISSION_DENIED|Missing or insufficient permissions/i.test(message)) {
    throw new ApiError(
      503,
      "No hay acceso a perfiles de app-oficial-leon. Configura SERVICE_ACCOUNT_APP_OFICIAL o concede roles/datastore.user al service account de apiV2 en ese proyecto.",
      false,
      "APP_OFICIAL_PERMISSION_DENIED",
    );
  }
  throw error;
};

export const findUsuariosAppProfile = async (
  uid: string,
  email?: string,
): Promise<UsuariosAppProfile | null> => {
  try {
    const byDocId = await usuariosCol().doc(uid).get();
    if (byDocId.exists) {
      return {
        id: byDocId.id,
        ...(byDocId.data() as object),
      } as UsuariosAppProfile;
    }

    const byUid = await usuariosCol().where("uid", "==", uid).limit(1).get();
    if (!byUid.empty) {
      const doc = byUid.docs[0];
      return { id: doc.id, ...(doc.data() as object) } as UsuariosAppProfile;
    }

    if (email) {
      const byEmail = await usuariosCol()
        .where("email", "==", email.toLowerCase())
        .limit(1)
        .get();
      if (!byEmail.empty) {
        const doc = byEmail.docs[0];
        return { id: doc.id, ...(doc.data() as object) } as UsuariosAppProfile;
      }
    }

    return null;
  } catch (error) {
    return mapAppOficialFirestoreError(error);
  }
};

type LegacyPosUser = Record<string, unknown> & { id: string };

const isLegacyPosRole = (rol?: string | null): boolean =>
  Boolean(toInternalRole(rol));

/** Usuario POS legado en Firestore `users` (puntoventacl), sin migrar a usuariosApp. */
export const findLegacyPosUserByEmail = async (
  email: string,
): Promise<LegacyPosUser | null> => {
  const normalized = email.toLowerCase().trim();
  if (!normalized) return null;

  const snap = await legacyUsersCol()
    .where("email", "==", normalized)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();
  if (data.activo === false || !isLegacyPosRole(data.rol as string | undefined)) {
    return null;
  }

  return { id: doc.id, ...data };
};

const legacyPosUserToAppProfile = (
  legacy: LegacyPosUser,
  uid: string,
  email: string,
): UsuariosAppProfile => {
  const resolvedEmail = String(legacy.email ?? email).toLowerCase().trim();
  return {
    id: uid,
    uid,
    email: resolvedEmail,
    nombre: String(legacy.nombre ?? resolvedEmail),
    rol: toConcesionRole(String(legacy.rol ?? "VENDEDOR")),
    activo: legacy.activo !== false,
    from_concesion: true,
    concesionId:
      (legacy.concesionId as string | null | undefined) ??
      (legacy.idConcesion as string | null | undefined) ??
      null,
    sucursalId:
      (legacy.sucursalId as string | null | undefined) ??
      (legacy.idSucursal as string | null | undefined) ??
      null,
    cajaId: (legacy.cajaId as string | null | undefined) ?? null,
    fecha_nacimiento:
      (legacy.fecha_nacimiento as string | undefined) ??
      (typeof legacy.fechaNacimiento === "string"
        ? legacy.fechaNacimiento
        : undefined),
  };
};

/**
 * Resuelve el perfil POS: usuariosApp con rol de concesión, o fallback a `users`
 * legado si el email ya existía como CLIENTE en la app oficial (sin migración).
 */
export const resolvePosProfile = async (
  uid: string,
  email?: string,
): Promise<UsuariosAppProfile> => {
  const appProfile = await findUsuariosAppProfile(uid, email);
  if (appProfile && isPosEligibleUser(appProfile)) {
    return appProfile;
  }

  const lookupEmail = (email ?? appProfile?.email)?.toLowerCase().trim();
  if (lookupEmail) {
    const legacy = await findLegacyPosUserByEmail(lookupEmail);
    if (legacy) {
      return legacyPosUserToAppProfile(legacy, uid, lookupEmail);
    }
  }

  assertPosAccess(appProfile);
  throw new ApiError(
    403,
    "No tienes acceso al punto de venta de concesiones",
    true,
    "FORBIDDEN",
  );
};

/** Perfil expuesto al POS (rol interno + campos de concesión). */
export const toPosUsuario = (profile: UsuariosAppProfile) => {
  const internalRol = toInternalRole(profile.rol);
  const fechaNacimiento =
    profile.fecha_nacimiento ??
    (typeof profile.fechaNacimiento === "string"
      ? profile.fechaNacimiento
      : undefined);

  return {
    id: profile.id,
    uid: profile.uid,
    email: profile.email,
    nombre: profile.nombre,
    rol: internalRol,
    rolOriginal: profile.rol,
    from_concesion: profile.from_concesion === true,
    activo: profile.activo !== false,
    concesionId: profile.concesionId ?? null,
    sucursalId: profile.sucursalId ?? null,
    cajaId: profile.cajaId ?? null,
    fecha_nacimiento: fechaNacimiento,
    admin: false,
    isAdmin: false,
  };
};

/** Resuelve concesionId directo o vía sucursal asignada al vendedor. */
const resolveConcesionIdForNombre = async (params: {
  concesionId?: string | null;
  sucursalId?: string | null;
}): Promise<string | null> => {
  const direct = params.concesionId?.trim();
  if (direct) return direct;

  const sucursalId = params.sucursalId?.trim();
  if (!sucursalId) return null;

  try {
    const doc = await firestorePos
      .collection(COLLECTIONS.SUCURSALES)
      .doc(sucursalId)
      .get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    const fromSucursal =
      (data.concesion_id as string | undefined) ??
      (data.concesionId as string | undefined);
    return typeof fromSucursal === "string" && fromSucursal.trim()
      ? fromSucursal.trim()
      : null;
  } catch {
    return null;
  }
};

/** Enriquecer el perfil POS con el nombre de la concesión (para mostrar en el POS). */
export const withConcesionNombre = async <
  T extends { concesionId?: string | null; sucursalId?: string | null },
>(
  usuario: T,
): Promise<T & { concesionNombre: string | null }> => {
  const concesionId = await resolveConcesionIdForNombre(usuario);
  const concesionNombre = await getConcessionNombre(concesionId);
  return { ...usuario, concesionNombre };
};

const CAJA_INACTIVA_MESSAGE =
  "Caja inactiva. Contacta al administrador.";
const CAJA_NO_ASIGNADA_MESSAGE =
  "No tienes una caja asignada. Contacta al administrador.";

/**
 * Bloquea login/sesión POS si el vendedor no tiene caja asignada en su perfil
 * o si la caja está desactivada. Fuente de verdad: `cajaId` + `sucursalId` del
 * perfil (usuariosApp / users legado). Los ADMIN no requieren caja.
 */
export const assertCajaActivaForPosLogin = async (
  profile: UsuariosAppProfile,
) => {
  if (toInternalRole(profile.rol) !== UserRole.VENDEDOR) return;

  const sucursalId = profile.sucursalId?.trim();
  const cajaId = profile.cajaId?.trim();
  if (!sucursalId || !cajaId) {
    throw new ApiError(
      403,
      CAJA_NO_ASIGNADA_MESSAGE,
      true,
      "CAJA_NO_ASIGNADA",
    );
  }

  try {
    const caja = await sucursalService.getCajaById(sucursalId, cajaId);
    if (caja.activo === false) {
      throw new ApiError(403, CAJA_INACTIVA_MESSAGE, true, "CAJA_INACTIVA");
    }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "NOT_FOUND") {
        throw new ApiError(403, CAJA_INACTIVA_MESSAGE, true, "CAJA_INACTIVA");
      }
      throw error;
    }
    throw error;
  }
};

export const assertPosAccess = (profile: UsuariosAppProfile | null) => {
  if (!profile) {
    throw new ApiError(
      403,
      "Usuario no registrado en el sistema de concesiones",
      true,
      "NOT_CONCESION_USER",
    );
  }
  if (profile.activo === false) {
    throw new ApiError(403, "La cuenta está desactivada", true, "USER_INACTIVE");
  }
  if (!isPosEligibleUser(profile)) {
    const rol = profile.rol ?? "sin rol";
    throw new ApiError(
      403,
      `No tienes acceso al punto de venta de concesiones (rol actual: ${rol}, from_concesion: ${String(profile.from_concesion)}). Si este email es de POS y ya existía como CLIENTE en la app, ejecuta: npm run migrate:users-app-oficial:promote`,
      true,
      "FORBIDDEN",
    );
  }
};

export const signPosJwt = (profile: UsuariosAppProfile): string => {
  const payload = {
    uid: profile.uid,
    email: profile.email,
    rol: profile.rol,
    nombre: profile.nombre ?? "",
    admin: false,
  };
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  } as jwt.SignOptions);
};

export const verifyPosJwt = (token: string): { uid: string; email?: string; rol?: string; nombre?: string } => {
  try {
    return jwt.verify(token, getJwtSecret()) as {
      uid: string;
      email?: string;
      rol?: string;
      nombre?: string;
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, "Token expirado", true, "TOKEN_EXPIRED");
    }
    throw new ApiError(401, "Token inválido o expirado", true, "INVALID_TOKEN");
  }
};

/**
 * Login con email/password vía Identity Toolkit de app-oficial-leon.
 * Acepta usuariosApp con rol CONCESION_* o, si el email es POS legado,
 * hace fallback a la colección `users` sin migrar el documento.
 */
export const loginWithPassword = async (email: string, password: string) => {
  if (!hasAppOficialCredentials && process.env.NODE_ENV !== "production") {
    // En local sin SA aún puede funcionar Identity Toolkit + lectura si hay ADC.
  }

  const apiKey = getFirebaseApiKey();
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;

  let uid: string;
  let resolvedEmail: string;
  try {
    const resp = await axios.post(url, {
      email: email.toLowerCase().trim(),
      password,
      returnSecureToken: true,
    });
    uid = resp.data.localId as string;
    resolvedEmail = (resp.data.email as string) || email.toLowerCase().trim();
  } catch {
    throw new ApiError(
      401,
      "Credenciales inválidas",
      true,
      "INVALID_CREDENTIALS",
    );
  }

  const profile = await resolvePosProfile(uid, resolvedEmail);
  await assertCajaActivaForPosLogin(profile);

  // Sincronizar claims (admin siempre false para concesiones)
  try {
    await authAppOficial.setCustomUserClaims(uid, {
      admin: false,
      rol: profile.rol,
    });
  } catch {
    // No bloquear login si fallan claims
  }

  const token = signPosJwt(profile);
  return { token, usuario: await withConcesionNombre(toPosUsuario(profile)) };
};

/** Carga el perfil POS a partir de un JWT válido. */
export const resolveSessionFromToken = async (token: string) => {
  const decoded = verifyPosJwt(token);
  const profile = await resolvePosProfile(decoded.uid, decoded.email);
  await assertCajaActivaForPosLogin(profile);
  return toPosUsuario(profile);
};
