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
