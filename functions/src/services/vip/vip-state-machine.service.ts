import { VipOrderStatus } from "../../models/vip.model";
import { ApiError } from "../../utils/api-error";

const transitions: Record<VipOrderStatus, ReadonlySet<VipOrderStatus>> = {
  PENDING_PAYMENT: new Set([VipOrderStatus.PAID, VipOrderStatus.PAYMENT_FAILED, VipOrderStatus.CANCELLED]),
  PAID: new Set([VipOrderStatus.RECEIVED, VipOrderStatus.CANCELLED]),
  RECEIVED: new Set([VipOrderStatus.ACCEPTED, VipOrderStatus.CANCELLED]),
  ACCEPTED: new Set([VipOrderStatus.PREPARING, VipOrderStatus.ON_THE_WAY, VipOrderStatus.DELIVERED, VipOrderStatus.CANCELLED]),
  PREPARING: new Set([VipOrderStatus.READY_FOR_PICKUP, VipOrderStatus.ON_THE_WAY, VipOrderStatus.DELIVERED, VipOrderStatus.CANCELLED]),
  READY_FOR_PICKUP: new Set([VipOrderStatus.PICKED_UP, VipOrderStatus.ON_THE_WAY, VipOrderStatus.DELIVERED, VipOrderStatus.CANCELLED]),
  PICKED_UP: new Set([VipOrderStatus.ON_THE_WAY, VipOrderStatus.DELIVERED, VipOrderStatus.CANCELLED]),
  ON_THE_WAY: new Set([VipOrderStatus.DELIVERED, VipOrderStatus.CANCELLED]),
  DELIVERED: new Set(),
  CANCELLED: new Set([VipOrderStatus.REFUNDED]),
  PAYMENT_FAILED: new Set([VipOrderStatus.PENDING_PAYMENT, VipOrderStatus.CANCELLED]),
  REFUNDED: new Set(),
};

export const canTransitionVipOrder = (from: VipOrderStatus, to: VipOrderStatus): boolean =>
  from === to || transitions[from].has(to);

export const assertVipOrderTransition = (from: VipOrderStatus, to: VipOrderStatus): void => {
  if (!canTransitionVipOrder(from, to)) {
    throw new ApiError(
      409,
      `No se permite cambiar una orden de palcos de ${from} a ${to}`,
      true,
      "VIP_INVALID_STATE_TRANSITION",
    );
  }
};

export const isVipTerminalStatus = (status: VipOrderStatus): boolean =>
  [VipOrderStatus.DELIVERED, VipOrderStatus.CANCELLED, VipOrderStatus.REFUNDED, VipOrderStatus.PAYMENT_FAILED].includes(status);

export const isVipDeliverableStatus = (status: VipOrderStatus): boolean =>
  [
    VipOrderStatus.ACCEPTED,
    VipOrderStatus.PREPARING,
    VipOrderStatus.READY_FOR_PICKUP,
    VipOrderStatus.PICKED_UP,
    VipOrderStatus.ON_THE_WAY,
  ].includes(status);
