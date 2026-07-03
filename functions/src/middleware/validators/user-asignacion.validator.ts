import { z } from "zod";

export const assignVendedorSchema = z
  .object({
    sucursalId: z.string().min(1),
    cajaId: z.string().min(1).nullable(),
    concesionId: z.string().min(1).optional(),
  })
  .strict();

export type AssignVendedorInput = z.infer<typeof assignVendedorSchema>;
