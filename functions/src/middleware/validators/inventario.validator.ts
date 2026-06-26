import { z } from "zod";

export const upsertInventarioProductoSchema = z
  .object({
    producto_id: z.string().min(1).optional(),
    cantidad_inicial: z.number().nonnegative().optional(),
    cantidad_final: z.number().nonnegative().optional(),
    precio_jornada: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type UpsertInventarioProductoInput = z.infer<
  typeof upsertInventarioProductoSchema
>;
