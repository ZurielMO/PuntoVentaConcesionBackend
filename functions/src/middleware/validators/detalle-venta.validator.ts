import { z } from "zod";

const detalleProductoSchema = z
  .object({
    producto: z.string().min(1).optional(),
    combo: z.string().min(1).optional(),
    cantidad: z.number().positive(),
    precio_actual: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((data) => Boolean(data.producto) !== Boolean(data.combo), {
    message: "Cada línea debe tener producto o combo, no ambos",
  });

const metodoPagoSchema = z.enum([
  "efectivo",
  "tarjeta",
  "puntos",
  "puntos+efectivo",
  "puntos+tarjeta",
]);

const abonadoVentaSchema = z
  .object({
    benefitId: z.string().min(1),
    titulo: z.string().min(1),
    montoTotal: z.number().nonnegative(),
    montoDescuento: z.number().nonnegative(),
    unidadesGratis: z.number().int().nonnegative(),
    tipo: z.string().trim().min(1).optional(),
  })
  .strict();

const ventaFields = {
  productos: z.array(detalleProductoSchema).min(1),
  metodoPago: metodoPagoSchema.optional().default("efectivo"),
  puntosUsados: z.number().int().nonnegative().optional().default(0),
  memberId: z.string().trim().min(1).optional(),
  abonado: abonadoVentaSchema.optional(),
};

const requirePointsMember = (
  data: { puntosUsados: number; metodoPago: string; memberId?: string },
  ctx: z.RefinementCtx,
) => {
  const usesPoints =
    data.puntosUsados > 0 || String(data.metodoPago).startsWith("puntos");
  if (usesPoints && !data.memberId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "memberId es requerido para pagar con puntos",
      path: ["memberId"],
    });
  }
};

/** Ventas con sesión de usuario: la caja se indica y el servidor la valida. */
export const createDetalleVentaSchema = z
  .object({
    ...ventaFields,
    cajaId: z.string().trim().min(1).max(200).regex(/^[^/]+$/).optional(),
  })
  .strict()
  .superRefine(requirePointsMember);

/** Ventas de PDA: la caja sale de su token, así que el cuerpo no la acepta. */
export const createPdaVentaSchema = z
  .object(ventaFields)
  .strict()
  .superRefine(requirePointsMember);

export const updateDetalleVentaSchema = z
  .object({
    productos: z.array(detalleProductoSchema).min(1),
  })
  .strict();

export type CreateDetalleVentaInput = z.infer<typeof createDetalleVentaSchema>;
export type UpdateDetalleVentaInput = z.infer<typeof updateDetalleVentaSchema>;
