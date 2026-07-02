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
    const data = byDocId.data();
    return {
      id: byDocId.id,
      ...data,
      concesionId: data?.concesionId || data?.idConcesion || null,
      sucursalId: data?.sucursalId || data?.idSucursal || null,
    };
  }

  // 2) campo uid == uid
  const byUid = await users.where("uid", "==", uid).limit(1).get();
  if (!byUid.empty) {
    const data = byUid.docs[0].data();
    return {
      id: byUid.docs[0].id,
      ...data,
      concesionId: data?.concesionId || data?.idConcesion || null,
      sucursalId: data?.sucursalId || data?.idSucursal || null,
    };
  }

  // 3) email legacy
  if (email) {
    const byEmail = await users
      .where("email", "==", email.toLowerCase())
      .limit(1)
      .get();
    if (!byEmail.empty) {
      const data = byEmail.docs[0].data();
      return {
        id: byEmail.docs[0].id,
        ...data,
        concesionId: data?.concesionId || data?.idConcesion || null,
        sucursalId: data?.sucursalId || data?.idSucursal || null,
      };
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

    const normalizedRole =
      typeof (profile?.rol || decoded.rol) === "string"
        ? String(profile?.rol || decoded.rol).toUpperCase() === "EMPLEADO"
          ? "VENDEDOR"
          : String(profile?.rol || decoded.rol).toUpperCase()
        : "VENDEDOR";

    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      admin: decoded.admin === true,
      isAdmin: decoded.isAdmin === true,
      rol: normalizedRole,
      concesionId: profile?.concesionId || profile?.idConcesion || null,
      sucursalId: profile?.sucursalId || profile?.idSucursal || null,
      activo: profile?.activo !== false,
      ...(profile ?? {}),
    } as Express.AuthenticatedUser;

    next();
  },
);

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
