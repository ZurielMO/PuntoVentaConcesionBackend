import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod";

type Target = "body" | "params" | "query";

const buildValidator =
  (schema: ZodSchema, target: Target, errorCode?: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[target]);
      // req.query es readonly en algunas versiones; asignamos cuando es posible.
      if (target === "query") {
        Object.defineProperty(req, "query", {
          value: parsed,
          writable: true,
          configurable: true,
        });
      } else {
        req[target] = parsed;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          ...(errorCode ? { code: errorCode } : {}),
          message: "Validación fallida",
          errors: error.errors.map((err) => ({
            campo: err.path.join("."),
            mensaje: err.message,
            codigo: err.code,
          })),
        });
        return;
      }
      next(error);
    }
  };

export const validateBody = (schema: ZodSchema, errorCode?: string) =>
  buildValidator(schema, "body", errorCode);
export const validateParams = (schema: ZodSchema, errorCode?: string) =>
  buildValidator(schema, "params", errorCode);
export const validateQuery = (schema: ZodSchema, errorCode?: string) =>
  buildValidator(schema, "query", errorCode);
