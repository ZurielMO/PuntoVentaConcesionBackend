import { z } from "zod";

export const ticketStatusEnum = z.enum([
  "PENDIENTE",
  "COMPLETADA",
  "CANCELADA",
]);

export const createTicketSchema = z
  .object({
    fecha: z.string().min(1),
    metodo_pago: z.string().min(1),
    subtotal: z.number().nonnegative(),
    total: z.number().nonnegative(),
    status: ticketStatusEnum.optional().default("PENDIENTE"),
  })
  .strict();

export const updateTicketSchema = z
  .object({
    metodo_pago: z.string().min(1).optional(),
    subtotal: z.number().nonnegative().optional(),
    total: z.number().nonnegative().optional(),
    status: ticketStatusEnum.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
