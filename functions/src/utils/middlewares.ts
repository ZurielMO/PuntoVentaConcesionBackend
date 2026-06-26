import { Request, Response, NextFunction } from "express";
import { authAdmin, firestorePos, hasAdminCredentials } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "./api-error";
import { asyncHandler } from "./error-handler";

const isProductionRuntime = (): boolean =>
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.K_SERVICE || process.env.FUNCTION_NAME);

/** Bloquea rutas de diagnóstico (/debug) en producción. */
export const blockDebugInProduction = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!isProductionRuntime()) {
    next();
    return;
  }
  if (req.path.toLowerCase().includes("/debug")) {
    res.status(404).json({ success: false, message: "Ruta no encontrada" });
    return;
  }
  next();
};

/**
 * Devuelve 503 si no hay credenciales de Firebase configuradas en local.
 * Útil para dar un mensaje claro antes de intentar tocar Firestore/Auth.
 */
export const requireFirebaseReady = (
  _req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!hasAdminCredentials && !isProductionRuntime()) {
    throw new ApiError(
      503,
      "Servicio no disponible: faltan credenciales del servidor. Coloca serviceAccountKey.json en la raiz del repo o define GOOGLE_APPLICATION_CREDENTIALS / SERVICE_ACCOUNT_KEY.",
      true,
      "FIREBASE_NOT_CONFIGURED",
    );
  }
  next();
};

/** Busca el perfil POS del usuario en la colección `users`. */
const findPosProfile = async (
  uid: string,
  email?: string,
): Promise<FirebaseFirestore.DocumentData | null> => {
  const users = firestorePos.collection(COLLECTIONS.USERS);

  // 1) docId == uid
  const byDocId = await users.doc(uid).get();
  if (byDocId.exists) {
    return { id: byDocId.id, ...byDocId.data() };
  }

  // 2) campo uid == uid
  const byUid = await users.where("uid", "==", uid).limit(1).get();
  if (!byUid.empty) {
    return { id: byUid.docs[0].id, ...byUid.docs[0].data() };
  }

  // 3) email legacy
  if (email) {
    const byEmail = await users
      .where("email", "==", email.toLowerCase())
      .limit(1)
      .get();
    if (!byEmail.empty) {
      return { id: byEmail.docs[0].id, ...byEmail.docs[0].data() };
    }
  }

  return null;
};

/**
 * Autenticación requerida con Firebase ID token.
 * Verifica el token y enriquece `req.user` con el perfil POS (colección users).
 */
export const authMiddleware = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    if (!hasAdminCredentials && !isProductionRuntime()) {
      throw new ApiError(
        503,
        "Servicio no disponible: faltan credenciales del servidor. Coloca serviceAccountKey.json en la raiz del repo.",
        true,
        "FIREBASE_NOT_CONFIGURED",
      );
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(
        401,
        "No autenticado: falta el token Bearer",
        true,
        "UNAUTHENTICATED",
      );
    }

    const token = authHeader.slice("Bearer ".length).trim();

    let decoded;
    try {
      decoded = await authAdmin.verifyIdToken(token);
    } catch {
      throw new ApiError(
        401,
        "Token inválido o expirado",
        true,
        "INVALID_TOKEN",
      );
    }

    const profile = await findPosProfile(decoded.uid, decoded.email);

    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      admin: decoded.admin === true,
      isAdmin: decoded.isAdmin === true,
      ...(profile ?? {}),
    } as Express.AuthenticatedUser;

    next();
  },
);

const ADMIN_ROLES = ["SUPERADMIN", "ADMIN", "EMPLEADO"];

/** Requiere rol administrativo (o claim admin/isAdmin). Bloquea si activo === false. */
export const requireAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const user = req.user;
  if (!user) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }

  if (user.activo === false) {
    throw new ApiError(403, "La cuenta está desactivada", true, "USER_INACTIVE");
  }

  const rol = typeof user.rol === "string" ? user.rol.toUpperCase() : undefined;
  const isAdmin =
    user.admin === true ||
    user.isAdmin === true ||
    (rol ? ADMIN_ROLES.includes(rol) : false);

  if (!isAdmin) {
    throw new ApiError(
      403,
      "No tienes permisos administrativos",
      true,
      "FORBIDDEN",
    );
  }

  next();
};

/** Requiere rol SUPERADMIN (crear usuarios POS). */
export const requireSuperAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const user = req.user;
  if (!user) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }
  if (user.activo === false) {
    throw new ApiError(403, "La cuenta está desactivada", true, "USER_INACTIVE");
  }

  const rol = typeof user.rol === "string" ? user.rol.toUpperCase() : undefined;
  if (rol !== "SUPERADMIN" && user.admin !== true) {
    throw new ApiError(
      403,
      "Se requiere rol SUPERADMIN",
      true,
      "FORBIDDEN",
    );
  }

  next();
};

/** Autenticación opcional: si hay token válido lo decodifica; si no, continúa. */
export const optionalAuthMiddleware = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ") || !hasAdminCredentials) {
      next();
      return;
    }
    try {
      const token = authHeader.slice("Bearer ".length).trim();
      const decoded = await authAdmin.verifyIdToken(token);
      const profile = await findPosProfile(decoded.uid, decoded.email);
      req.user = {
        uid: decoded.uid,
        email: decoded.email,
        ...(profile ?? {}),
      } as Express.AuthenticatedUser;
    } catch {
      // Ignorar token inválido en modo opcional.
    }
    next();
  },
);
