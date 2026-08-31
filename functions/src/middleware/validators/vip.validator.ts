import { z } from "zod";
import { normalizeVipFloor, VIP_STADIUM_ZONES, VipOrderStatus } from "../../models/vip.model";

const id = z.string().trim().min(1).max(160);

const mxPhone = z.string().trim().min(10).max(20).refine((value) => {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 12 && digits.startsWith("52"));
}, "Teléfono inválido");

export const vipCheckoutSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(254),
    phone: mxPhone,
  }).strict(),
  delivery: z.object({
    zona: z.enum(VIP_STADIUM_ZONES),
    palco: z.string().trim().min(1).max(40),
    nivel: z.string().trim().min(1).max(40),
    notes: z.string().trim().max(500).optional(),
  }).strict().superRefine((delivery, ctx) => {
    if (!normalizeVipFloor(delivery.zona, delivery.nivel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nivel"],
        message: delivery.zona === "Oriente"
          ? "Elige el piso 1, 2 o 3 para Oriente."
          : "Elige el piso 1 o 2 para Poniente.",
      });
    }
  }).transform((delivery) => ({
    ...delivery,
    nivel: normalizeVipFloor(delivery.zona, delivery.nivel) || delivery.nivel,
  })),
  items: z.array(z.object({
    productId: id,
    quantity: z.number().int().positive().max(50),
    selectedOptions: z.array(id).max(20).optional().default([]),
    extras: z.array(id).max(20).optional().default([]),
    notes: z.string().trim().max(500).optional(),
  }).strict()).min(1).max(100),
  tip: z.number().nonnegative().max(10000).optional().default(0),
}).strict();

export const vipConfirmSessionSchema = z.object({
  sessionId: z.string().trim().min(7).max(255).regex(/^cs_[a-zA-Z0-9_]+$/),
}).strict();

const stripeSessionId = z.string().trim().min(7).max(255).regex(/^cs_[a-zA-Z0-9_]+$/);

export const vipAbandonCheckoutSchema = z.object({
  orderId: id.optional(),
  sessionId: stripeSessionId.optional(),
  trackingToken: z.string().trim().min(32).max(256).optional(),
}).strict().refine(
  (value) => Boolean(value.sessionId) || Boolean(value.orderId && value.trackingToken),
  { message: "Indica sessionId o orderId con trackingToken." },
);

export const vipTrackingQuerySchema = z.object({
  token: z.string().trim().min(32).max(256),
}).strict();

export const vipStatusSchema = z.object({
  status: z.nativeEnum(VipOrderStatus),
  metadata: z.record(z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]))
    .refine((value) => JSON.stringify(value).length <= 2000, "metadata excede 2000 caracteres")
    .optional(),
}).strict();

export const vipRunnerSchema = z.object({
  runnerId: id,
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(30).optional(),
}).strict();

export const vipCancelSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const vipAdminListSchema = z.object({
  status: z.nativeEnum(VipOrderStatus).optional(),
  fecha: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  jornadaId: id.optional(),
  zona: z.enum(VIP_STADIUM_ZONES),
  concessionId: id.optional(),
  sucursalId: id.optional(),
  runnerId: id.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(100),
}).strict();

export const vipCentralZoneUnlockSchema = z.object({
  password: z.string().min(1).max(80),
  zona: z.enum(VIP_STADIUM_ZONES),
}).strict();

export type VipCheckoutInput = z.infer<typeof vipCheckoutSchema>;
export type VipAbandonCheckoutInput = z.infer<typeof vipAbandonCheckoutSchema>;
