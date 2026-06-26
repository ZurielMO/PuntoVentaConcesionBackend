import { z } from "zod";

export const loginSchema = z
  .object({
    idToken: z.string().min(1, "idToken es obligatorio"),
  })
  .strict();

export const loginPasswordSchema = z
  .object({
    email: z.string().email("Email inválido"),
    password: z.string().min(1, "La contraseña es obligatoria"),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
