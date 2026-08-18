import { z } from "zod";

export const sucursalModoOperacionSchema = z.enum(["POS", "CONTEO"]);

export const createSucursalSchema = z
  .object({
    activo: z.boolean().optional().default(true),
    sucursal: z
      .object({
        nombre: z.string().min(1).optional(),
        cajas: z.array(z.string().min(1)).optional().default([]),
        modo_operacion: sucursalModoOperacionSchema.optional().default("POS"),
      })
      .strict(),
  })
  .strict();

export const updateSucursalSchema = z
  .object({
    activo: z.boolean().optional(),
    zona_id: z.string().min(1).optional(),
    sucursal: z
      .object({
        nombre: z.string().min(1).optional(),
        cajas: z.array(z.string().min(1)).optional(),
        modo_operacion: sucursalModoOperacionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateSucursalInput = z.infer<typeof createSucursalSchema>;
export type UpdateSucursalInput = z.infer<typeof updateSucursalSchema>;
