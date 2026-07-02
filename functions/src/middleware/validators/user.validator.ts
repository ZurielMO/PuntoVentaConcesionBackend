import { z } from "zod";

const assignableRolSchema = z.enum(["ADMIN", "VENDEDOR", "EMPLEADO"]);

export const userRolEnum = z.enum(["SUPERADMIN", "ADMIN", "VENDEDOR", "EMPLEADO"]);

export const createUserSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    fecha_nacimiento: z.string().min(1),
    email: z.string().email("Email inválido"),
    password: z.string().min(6, "Mínimo 6 caracteres"),
    rol: assignableRolSchema,
    activo: z.boolean().optional().default(true),
    concesionId: z.string().min(1),
    sucursalId: z.string().min(1).optional(),
    cajaId: z.string().min(1).optional().nullable(),
  })
  .strict()
  .refine(
    (data) => {
      const rol = data.rol === "EMPLEADO" ? "VENDEDOR" : data.rol;
      if (rol === "VENDEDOR" && !data.sucursalId) return false;
      return true;
    },
    { message: "Los VENDEDORES requieren sucursalId", path: ["sucursalId"] },
  );

export const updateUserSchema = z
  .object({
    nombre: z.string().min(1).max(200).optional(),
    fecha_nacimiento: z.string().min(1).optional(),
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    rol: assignableRolSchema.optional(),
    activo: z.boolean().optional(),
    concesionId: z.string().min(1).optional(),
    sucursalId: z.string().min(1).optional().nullable(),
    cajaId: z.string().min(1).optional().nullable(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
