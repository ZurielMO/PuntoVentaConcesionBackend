import { z } from "zod";

export const assignVentaPointsSchema = z
  .object({
    memberId: z.string().trim().min(1, "memberId es requerido"),
    total: z
      .number({
        required_error: "total es requerido",
        invalid_type_error: "total debe ser un número",
      })
      .positive("total debe ser mayor a cero")
      .finite("total debe ser un número válido"),
  })
  .strict();

export type AssignVentaPointsInput = z.infer<typeof assignVentaPointsSchema>;

export const consumeAbonadoBenefitSchema = z
  .object({
    ventaId: z.string().trim().min(1, "ventaId es requerido"),
  })
  .strict();

export type ConsumeAbonadoBenefitInput = z.infer<
  typeof consumeAbonadoBenefitSchema
>;

export const assignCinepolisPointsSchema = z
  .object({
    memberId: z.string().trim().min(1, "memberId es requerido"),
    dinero: z
      .number({
        required_error: "El monto es requerido",
        invalid_type_error: "El monto debe ser un número",
      })
      .positive("El monto debe ser mayor a cero")
      .finite("El monto debe ser un número válido"),
    comentario: z
      .string()
      .trim()
      .max(250, "El comentario no puede exceder 250 caracteres")
      .optional(),
  })
  .strict();

export type AssignCinepolisPointsInput = z.infer<
  typeof assignCinepolisPointsSchema
>;

export const cinepolisAsignacionesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type CinepolisAsignacionesQuery = z.infer<
  typeof cinepolisAsignacionesQuerySchema
>;
