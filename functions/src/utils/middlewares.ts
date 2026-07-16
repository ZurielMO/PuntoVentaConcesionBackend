import { Request, Response, NextFunction } from "express";
import { hasAdminCredentials } from "../config/firebase";
import { hasAppOficialCredentials } from "../config/app.firebase";
import { ApiError } from "./api-error";
import { asyncHandler } from "./error-handler";
import * as authService from "../services/auth.service";

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

/**
 * Autenticación requerida con JWT de app-oficial-leon (mismo esquema que BackendCL).
 * Verifica el token y enriquece `req.user` con el perfil POS (usuariosApp).
 */
export const authMiddleware = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(
        401,
        "No autenticado: falta el token Bearer",
        true,
        "UNAUTHENTICATED",
      );
    }

    if (
      !hasAppOficialCredentials &&
      !hasAdminCredentials &&
      !isProductionRuntime()
    ) {
      throw new ApiError(
        503,
        "Servicio no disponible: faltan credenciales de app-oficial-leon (SERVICE_ACCOUNT_APP_OFICIAL).",
        true,
        "FIREBASE_NOT_CONFIGURED",
      );
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const usuario = await authService.resolveSessionFromToken(token);

    req.user = {
      ...usuario,
      uid: usuario.uid,
      email: usuario.email,
      rol: usuario.rol,
      rolOriginal: usuario.rolOriginal,
      from_concesion: usuario.from_concesion,
      concesionId: usuario.concesionId,
      sucursalId: usuario.sucursalId,
      cajaId: usuario.cajaId,
      activo: usuario.activo,
      admin: false,
      isAdmin: false,
      nombre: usuario.nombre,
    } as Express.AuthenticatedUser;

    next();
  },
);

/** Autenticación opcional: si hay token válido lo decodifica; si no, continúa. */
export const optionalAuthMiddleware = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      next();
      return;
    }
    try {
      const token = authHeader.slice("Bearer ".length).trim();
      const usuario = await authService.resolveSessionFromToken(token);
      req.user = {
        ...usuario,
        uid: usuario.uid,
        email: usuario.email,
        rol: usuario.rol,
      } as Express.AuthenticatedUser;
    } catch {
      // Ignorar token inválido en modo opcional.
    }
    next();
  },
);
