/**
 * Utilidades para manejo de errores.
 * Funciones y middleware para gestión centralizada de errores.
 */

import { Request, Response, NextFunction } from "express";
import { ApiError } from "./api-error";
import { buildPublicErrorBody, logSafeError } from "./public-error.util";

export { ApiError };

/**
 * Middleware global de manejo de errores.
 * Debe ser el último middleware en app.ts.
 */
export const errorHandler = (
  err: Error | ApiError,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    return next(err);
  }

  logSafeError("errorHandler", err, req.requestId);

  const { statusCode, body } = buildPublicErrorBody(err, req.requestId, {
    fallbackMessage: "Error interno del servidor",
    fallbackCode:
      err instanceof ApiError && err.code ? err.code : "INTERNAL_ERROR",
    fieldErrors: err instanceof ApiError ? err.fieldErrors : undefined,
  });

  return res.status(statusCode).json(body);
};

/**
 * Envuelve funciones async para que los errores lleguen al error handler.
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Middleware para rutas no encontradas (404).
 */
export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  logSafeError(
    "not_found",
    new Error(`${req.method} ${req.originalUrl}`),
    req.requestId,
  );

  const error = new ApiError(404, "Recurso no encontrado", true, "NOT_FOUND");
  next(error);
};
