import { z } from "zod";

const porcentajeComisionField = z
  .number()
  .min(0, "El porcentaje no puede ser negativo")
  .max(100, "El porcentaje no puede ser mayor a 100")
  .optional()
  .default(0);

export const concessionTipoSchema = z.enum(["GENERAL", "CERVECERIA"]);

const tipoField = concessionTipoSchema.optional().default("GENERAL");

export const createConcessionSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    activo: z.boolean().optional().default(true),
    imagenes: z.array(z.string().url()).optional().default([]),
    porcentajeComision: porcentajeComisionField,
    tipo: tipoField,
  })
  .strict();

export const replaceConcessionSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    activo: z.boolean().optional().default(true),
    // Omitido = conservar imágenes existentes (reactivar / editar nombre sin tocar logo).
    // Enviar [] limpia el logo a propósito.
    imagenes: z.array(z.string().url()).optional(),
    porcentajeComision: porcentajeComisionField,
    // Omitido = conservar tipo existente.
    tipo: concessionTipoSchema.optional(),
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
export const assignUserToConcessionSchema = z
  .object({
    userId: z.string().min(1, "userId es obligatorio"),
  })
  .strict();

export type AssignUserToConcessionInput = z.infer<typeof assignUserToConcessionSchema>;

export const updateConcessionComisionSchema = z
  .object({
    porcentajeComision: z
      .number()
      .min(0, "El porcentaje no puede ser negativo")
      .max(100, "El porcentaje no puede ser mayor a 100"),
  })
  .strict();

export type UpdateConcessionComisionInput = z.infer<
  typeof updateConcessionComisionSchema
>;

