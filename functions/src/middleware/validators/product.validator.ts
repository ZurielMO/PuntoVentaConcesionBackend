import { z } from "zod";

export const createProductSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    unidad_medida: z.string().min(1).max(50),
    precio: z.number().nonnegative(),
    imagenes: z.array(z.string().url()).optional().default([]),
    activo: z.boolean().optional().default(true),
  })
  .strict();

export const updateProductSchema = z
  .object({
    nombre: z.string().min(1).max(200).optional(),
    unidad_medida: z.string().min(1).max(50).optional(),
    precio: z.number().nonnegative().optional(),
    imagenes: z.array(z.string().url()).optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
