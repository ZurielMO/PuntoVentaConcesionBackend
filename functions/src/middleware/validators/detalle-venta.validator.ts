import { z } from "zod";

const detalleProductoSchema = z
  .object({
    producto: z.string().min(1),
    cantidad: z.number().positive(),
    precio_actual: z.number().nonnegative(),
  })
  .strict();

export const createDetalleVentaSchema = z
  .object({
    productos: z.array(detalleProductoSchema).min(1),
  })
  .strict();

export const updateDetalleVentaSchema = z
  .object({
    productos: z.array(detalleProductoSchema).min(1),
  })
  .strict();

export type CreateDetalleVentaInput = z.infer<typeof createDetalleVentaSchema>;
export type UpdateDetalleVentaInput = z.infer<typeof updateDetalleVentaSchema>;
