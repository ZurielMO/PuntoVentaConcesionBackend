import { z } from "zod";

export const upsertAsignacionesCajasSchema = z
  .object({
    sucursalId: z.string().min(1),
    asignaciones: z
      .array(
        z
          .object({
            cajaId: z.string().min(1),
            vendedorUid: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type UpsertAsignacionesCajasInput = z.infer<
  typeof upsertAsignacionesCajasSchema
>;
