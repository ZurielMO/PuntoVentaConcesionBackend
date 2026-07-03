import { z } from "zod";

const descuentoTipoSchema = z.enum(["2X1", "3X2", "PORCENTAJE", "MONTO"]);

export const createDescuentoSchema = z
  .object({
    concesionId: z.string().min(1),
    titulo: z.string().min(1).max(200),
    descripcion: z.string().max(500).nullable().optional(),
    tipo: descuentoTipoSchema,
    valor: z.number().positive().nullable().optional(),
    producto_ids: z.array(z.string().min(1)).min(1),
    activo: z.boolean().optional().default(true),
  })
  .strict();

export const updateDescuentoSchema = z
  .object({
    titulo: z.string().min(1).max(200).optional(),
    descripcion: z.string().max(500).nullable().optional(),
    tipo: descuentoTipoSchema.optional(),
    valor: z.number().positive().nullable().optional(),
    producto_ids: z.array(z.string().min(1)).min(1).optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateDescuentoInput = z.infer<typeof createDescuentoSchema>;
export type UpdateDescuentoInput = z.infer<typeof updateDescuentoSchema>;
