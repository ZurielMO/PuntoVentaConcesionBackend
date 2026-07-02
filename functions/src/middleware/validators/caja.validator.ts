import { z } from "zod";

export const createCajaSchema = z
  .object({
    nombre: z.string().min(1).max(100),
    orden: z.number().int().nonnegative().optional(),
  })
  .strict();

export const updateCajaSchema = z
  .object({
    nombre: z.string().min(1).max(100).optional(),
    activo: z.boolean().optional(),
    orden: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateCajaInput = z.infer<typeof createCajaSchema>;
export type UpdateCajaInput = z.infer<typeof updateCajaSchema>;
