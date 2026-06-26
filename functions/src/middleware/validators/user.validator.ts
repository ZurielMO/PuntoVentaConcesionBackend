import { z } from "zod";

export const userRolEnum = z.enum(["SUPERADMIN", "ADMIN", "EMPLEADO"]);

export const createUserSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    fecha_nacimiento: z.string().min(1),
    email: z.string().email("Email inválido"),
    password: z.string().min(6, "Mínimo 6 caracteres"),
    rol: userRolEnum,
    activo: z.boolean().optional().default(true),
  })
  .strict();

export const updateUserSchema = z
  .object({
    nombre: z.string().min(1).max(200).optional(),
    fecha_nacimiento: z.string().min(1).optional(),
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    rol: userRolEnum.optional(),
    activo: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
