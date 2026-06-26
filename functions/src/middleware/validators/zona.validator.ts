import { z } from "zod";

export const createZonaSchema = z
  .object({
    zona: z.string().min(1).max(120),
    activo: z.boolean().optional().default(true),
  })
  .strict();

export const updateZonaSchema = z
  .object({
    zona: z.string().min(1).max(120).optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateZonaInput = z.infer<typeof createZonaSchema>;
export type UpdateZonaInput = z.infer<typeof updateZonaSchema>;
