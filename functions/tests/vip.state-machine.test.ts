import { VipOrderStatus } from "../src/models/vip.model";
import {
  assertVipOrderTransition,
  canTransitionVipOrder,
  isVipDeliverableStatus,
  isVipTerminalStatus,
} from "../src/services/vip/vip-state-machine.service";

describe("VIP order state machine", () => {
  const happyPath: Array<[VipOrderStatus, VipOrderStatus]> = [
    [VipOrderStatus.PENDING_PAYMENT, VipOrderStatus.PAID],
    [VipOrderStatus.PAID, VipOrderStatus.RECEIVED],
    [VipOrderStatus.RECEIVED, VipOrderStatus.ACCEPTED],
    [VipOrderStatus.ACCEPTED, VipOrderStatus.ON_THE_WAY],
    [VipOrderStatus.ACCEPTED, VipOrderStatus.DELIVERED],
    [VipOrderStatus.ON_THE_WAY, VipOrderStatus.DELIVERED],
    [VipOrderStatus.PREPARING, VipOrderStatus.READY_FOR_PICKUP],
    [VipOrderStatus.READY_FOR_PICKUP, VipOrderStatus.PICKED_UP],
    [VipOrderStatus.PICKED_UP, VipOrderStatus.ON_THE_WAY],
  ];

  it.each(happyPath)("allows %s -> %s", (from, to) => {
    expect(canTransitionVipOrder(from, to)).toBe(true);
    expect(() => assertVipOrderTransition(from, to)).not.toThrow();
  });

  it.each([
    [VipOrderStatus.DELIVERED, VipOrderStatus.PREPARING],
    [VipOrderStatus.PENDING_PAYMENT, VipOrderStatus.DELIVERED],
    [VipOrderStatus.RECEIVED, VipOrderStatus.DELIVERED],
    [VipOrderStatus.RECEIVED, VipOrderStatus.ON_THE_WAY],
    [VipOrderStatus.REFUNDED, VipOrderStatus.ACCEPTED],
  ])("rejects %s -> %s", (from, to) => {
    expect(() => assertVipOrderTransition(from, to)).toThrow("No se permite");
  });

  it("treats delivery, cancellation, refund and payment failure as terminal", () => {
    expect(isVipTerminalStatus(VipOrderStatus.DELIVERED)).toBe(true);
    expect(isVipTerminalStatus(VipOrderStatus.CANCELLED)).toBe(true);
    expect(isVipTerminalStatus(VipOrderStatus.REFUNDED)).toBe(true);
    expect(isVipTerminalStatus(VipOrderStatus.PAYMENT_FAILED)).toBe(true);
    expect(isVipTerminalStatus(VipOrderStatus.ON_THE_WAY)).toBe(false);
  });

  it("requires an accepted order before it can be delivered", () => {
    expect(canTransitionVipOrder(VipOrderStatus.RECEIVED, VipOrderStatus.ACCEPTED)).toBe(true);
    expect(canTransitionVipOrder(VipOrderStatus.ACCEPTED, VipOrderStatus.ON_THE_WAY)).toBe(true);
    expect(isVipDeliverableStatus(VipOrderStatus.ON_THE_WAY)).toBe(true);
    expect(isVipDeliverableStatus(VipOrderStatus.RECEIVED)).toBe(false);
    expect(canTransitionVipOrder(VipOrderStatus.RECEIVED, VipOrderStatus.DELIVERED)).toBe(false);
  });
});
