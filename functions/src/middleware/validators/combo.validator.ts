import { z } from "zod";

const comboProductoSchema = z
  .object({
    producto_id: z.string().min(1),
    cantidad: z.number().int().positive(),
  })
  .strict();

export const createComboSchema = z
  .object({
    concesionId: z.string().min(1),
    titulo: z.string().min(1).max(200),
    descripcion: z.string().max(500).nullable().optional(),
    productos: z.array(comboProductoSchema).min(1),
    precio: z.number().nonnegative(),
    activo: z.boolean().optional().default(true),
  })
  .strict();

export const updateComboSchema = z
  .object({
    titulo: z.string().min(1).max(200).optional(),
    descripcion: z.string().max(500).nullable().optional(),
    productos: z.array(comboProductoSchema).min(1).optional(),
    precio: z.number().nonnegative().optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateComboInput = z.infer<typeof createComboSchema>;
export type UpdateComboInput = z.infer<typeof updateComboSchema>;
