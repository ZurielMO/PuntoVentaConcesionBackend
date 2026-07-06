import { z } from "zod";

export const searchTrabajadorClubSchema = z
  .object({
    email: z.string().email().max(320),
  })
  .strict();

export const addTrabajadorClubSchema = z
  .object({
    uid: z.string().min(1).optional(),
    email: z.string().email().max(320).optional(),
  })
  .strict()
  .refine((d) => Boolean(d.uid || d.email), {
    message: "Debes enviar uid o email",
  });

export const updateCortesiaSchema = z
  .object({
    cortesiaCanjeada: z.boolean(),
  })
  .strict();

export type AddTrabajadorClubInput = z.infer<typeof addTrabajadorClubSchema>;
export type UpdateCortesiaInput = z.infer<typeof updateCortesiaSchema>;
