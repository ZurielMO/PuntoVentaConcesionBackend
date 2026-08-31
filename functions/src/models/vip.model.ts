export enum VipOrderStatus {
  PENDING_PAYMENT = "PENDING_PAYMENT",
  PAID = "PAID",
  RECEIVED = "RECEIVED",
  ACCEPTED = "ACCEPTED",
  PREPARING = "PREPARING",
  READY_FOR_PICKUP = "READY_FOR_PICKUP",
  PICKED_UP = "PICKED_UP",
  ON_THE_WAY = "ON_THE_WAY",
  DELIVERED = "DELIVERED",
  CANCELLED = "CANCELLED",
  PAYMENT_FAILED = "PAYMENT_FAILED",
  REFUNDED = "REFUNDED",
}

export const VIP_STADIUM_ZONES = ["Oriente", "Poniente"] as const;
export type VipStadiumZone = (typeof VIP_STADIUM_ZONES)[number];

export const VIP_ZONE_FLOORS: Record<VipStadiumZone, readonly number[]> = {
  Oriente: [1, 2, 3],
  Poniente: [1, 2],
};

export const vipFloorLabel = (floor: number): string => `Piso ${floor}`;

export const isVipStadiumZone = (value: string): value is VipStadiumZone =>
  (VIP_STADIUM_ZONES as readonly string[]).includes(value);

/** Accepts "2", "Piso 2", "Nivel 2". Returns canonical "Piso N" or null. */
export const normalizeVipFloor = (zona: string, nivel: string): string | null => {
  if (!isVipStadiumZone(zona)) return null;
  const match = String(nivel || "").trim().match(/(\d+)/);
  const floor = match ? Number(match[1]) : NaN;
  if (!VIP_ZONE_FLOORS[zona].includes(floor)) return null;
  return vipFloorLabel(floor);
};

export enum VipPaymentStatus {
  PENDING = "PENDING",
  REQUIRES_ACTION = "REQUIRES_ACTION",
  PAID = "PAID",
  FAILED = "FAILED",
  REFUND_PENDING = "REFUND_PENDING",
  REFUNDED = "REFUNDED",
  PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED",
}

export enum VipReservationStatus {
  ACTIVE = "ACTIVE",
  CONFIRMED = "CONFIRMED",
  RELEASED = "RELEASED",
  RESTORED = "RESTORED",
}

export type VipActor = {
  actorId: string | null;
  actorRole: string;
};

export type VipOrderItemSnapshot = {
  id: string;
  productId: string;
  concessionId: string;
  inventoryId: string;
  sucursalId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  unitPriceMinor: number;
  selectedOptions: Array<{ id: string; name: string; price: number; priceMinor: number }>;
  extras: Array<{ id: string; name: string; price: number; priceMinor: number }>;
  notes: string | null;
  lineTotal: number;
  lineTotalMinor: number;
};

export type VipFulfillment = {
  id: string;
  concessionId: string;
  concessionName: string;
  sucursalId: string;
  inventoryId: string;
  itemIds: string[];
  status: VipOrderStatus;
  subtotal: number;
  subtotalMinor: number;
};

export type VipOrder = {
  id: string;
  orderNumber: string;
  fecha: string;
  jornadaId: string;
  matchId: string;
  customer: { name: string; email: string; phone: string | null };
  delivery: {
    locationId: string | null;
    zonaId: string;
    zona: string;
    palco: string;
    nivel: string;
    notes: string | null;
  };
  items: VipOrderItemSnapshot[];
  fulfillments: VipFulfillment[];
  concessionIds: string[];
  sucursalIds: string[];
  subtotal: number;
  subtotalMinor: number;
  serviceFee: number;
  serviceFeeMinor: number;
  tip: number;
  tipMinor: number;
  total: number;
  totalMinor: number;
  currency: string;
  payment: {
    status: VipPaymentStatus;
    provider: "STRIPE";
    checkoutSessionId: string | null;
    paymentIntentId: string | null;
    refundId: string | null;
    refundedAmountMinor?: number;
    amountMinor: number;
    currency: string;
  };
  status: VipOrderStatus;
  runner: { id: string; name: string; phone: string | null } | null;
  runnerId: string | null;
  trackingTokenHash: string;
  reservationExpiresAt: FirebaseFirestore.Timestamp;
  capacityReleased: boolean;
  inventoryConfirmed: boolean;
  salesRecorded: boolean;
  source: "VIP";
  channel: "VIP_DELIVERY";
  timestamps: Record<string, FirebaseFirestore.Timestamp | null>;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
};
