import axios from "axios";
import jwt from "jsonwebtoken";
import {
  authAppOficial,
  firestoreApp,
  hasAppOficialCredentials,
  USUARIOS_APP_COLLECTION,
} from "../config/app.firebase";
import { ApiError } from "../utils/api-error";
import {
  isPosEligibleUser,
  toInternalRole,
} from "../utils/concesion-roles";

const usuariosCol = () => firestoreApp.collection(USUARIOS_APP_COLLECTION);

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

export const findUsuariosAppProfile = async (
  uid: string,
  email?: string,
): Promise<UsuariosAppProfile | null> => {
  const byDocId = await usuariosCol().doc(uid).get();
  if (byDocId.exists) {
    return { id: byDocId.id, ...(byDocId.data() as object) } as UsuariosAppProfile;
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
 * Solo permite usuarios from_concesion con rol CONCESION_*.
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

  const profile = await findUsuariosAppProfile(uid, resolvedEmail);
  assertPosAccess(profile);

  // Sincronizar claims (admin siempre false para concesiones)
  try {
    await authAppOficial.setCustomUserClaims(uid, {
      admin: false,
      rol: profile!.rol,
    });
  } catch {
    // No bloquear login si fallan claims
  }

  const token = signPosJwt(profile!);
  return { token, usuario: toPosUsuario(profile!) };
};

/** Carga el perfil POS a partir de un JWT válido. */
export const resolveSessionFromToken = async (token: string) => {
  const decoded = verifyPosJwt(token);
  const profile = await findUsuariosAppProfile(decoded.uid, decoded.email);
  assertPosAccess(profile);
  return toPosUsuario(profile!);
};
