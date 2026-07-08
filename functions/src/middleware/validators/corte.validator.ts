import { z } from "zod";

export const createCorteSchema = z
  .object({
    fecha: z.string().min(1),
    comentarios: z.string().max(1000).optional(),
    estatus: z.string().min(1),
    totalReal: z.number(),
    totalCaja: z.number(),
    efectivoContado: z.number().nonnegative().optional(),
    diferenciaCaja: z.number().optional(),
  })
  .strict();

export const updateCorteSchema = z
  .object({
    fecha: z.string().min(1).optional(),
    comentarios: z.string().max(1000).optional(),
    estatus: z.string().min(1).optional(),
    totalReal: z.number().optional(),
    totalCaja: z.number().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export const cerrarCorteSchema = z
  .object({
    comentarios: z.string().max(1000).optional(),
    efectivoContado: z.number().nonnegative().optional(),
  })
  .strict();

export type CreateCorteInput = z.infer<typeof createCorteSchema>;
export type UpdateCorteInput = z.infer<typeof updateCorteSchema>;
export type CerrarCorteInput = z.infer<typeof cerrarCorteSchema>;
