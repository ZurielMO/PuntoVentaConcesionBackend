import { z } from "zod";

export const createConcessionSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    activo: z.boolean().optional().default(true),
    imagenes: z.array(z.string().url()).optional().default([]),
  })
  .strict();

export const replaceConcessionSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    activo: z.boolean().optional().default(true),
    imagenes: z.array(z.string().url()).optional().default([]),
  })
  .strict();

const positiveNumber = z
  .number({ invalid_type_error: "total debe ser un número" })
  .positive("total debe ser mayor a 0");

export const assignConcessionPointsSchema = z
  .object({
    idUser: z.string().min(1, "idUser es obligatorio"),
    total: positiveNumber,
    descripcion: z.string().min(1).max(500),
  })
  .strict();

export type CreateConcessionInput = z.infer<typeof createConcessionSchema>;
export type ReplaceConcessionInput = z.infer<typeof replaceConcessionSchema>;
export type AssignConcessionPointsInput = z.infer<
  typeof assignConcessionPointsSchema
>;
