jest.mock("../src/config/firebase", () => ({
  firestorePos: {
    collection: jest.fn(() => ({
      doc: jest.fn(),
      where: jest.fn(() => ({ limit: jest.fn(() => ({ get: jest.fn() })) })),
    })),
  },
}));

import { Timestamp } from "firebase-admin/firestore";
import { ApiError } from "../src/utils/api-error";
import { assertVipCapacity, assertVipServiceOpen } from "../src/services/vip/vip.service";

describe("VIP date service and capacity rules", () => {
  const now = Date.UTC(2026, 7, 26, 20, 0, 0);
  const open = () => ({
    enabled: true,
    acceptingOrders: true,
    opensAt: Timestamp.fromMillis(now - 60_000),
    closesAt: Timestamp.fromMillis(now + 60_000),
    maxActiveOrders: 10,
    activeOrderCount: 3,
  });

  it("accepts an open configured date below capacity", () => {
    expect(() => assertVipServiceOpen(open(), now)).not.toThrow();
    expect(() => assertVipCapacity(open())).not.toThrow();
  });

  it.each([
    ["disabled", { enabled: false }],
    ["paused", { acceptingOrders: false }],
    ["before opening", { opensAt: Timestamp.fromMillis(now + 1) }],
    ["after closing", { closesAt: Timestamp.fromMillis(now - 1) }],
  ])("fails closed when %s", (_name, override) => {
    expect(() => assertVipServiceOpen({ ...open(), ...override }, now)).toThrow(ApiError);
  });

  it("rejects reached capacity and allows unlimited when max is not configured", () => {
    expect(() => assertVipCapacity({ maxActiveOrders: 3, activeOrderCount: 3 })).toThrow("capacidad máxima");
    expect(() => assertVipCapacity({ activeOrderCount: 0 })).not.toThrow();
    expect(() => assertVipCapacity({ maxActiveOrders: 3 })).not.toThrow();
  });
});
