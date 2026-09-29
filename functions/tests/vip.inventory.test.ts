import { ApiError } from "../src/utils/api-error";
import {
  applyDeferredVipStock,
  confirmVipStock,
  releaseVipStock,
  reserveVipStock,
  restoreAppliedVipStock,
  shouldSettleDeferredPreorder,
} from "../src/services/vip/vip-inventory.service";

describe("VIP shared inventory reservation arithmetic", () => {
  it("reserves, confirms and releases without double-decrementing", () => {
    const reserved = reserveVipStock(5, 2);
    expect(reserved).toBe(3);
    expect(confirmVipStock(reserved)).toBe(3);
    expect(releaseVipStock(reserved, 2)).toBe(5);
  });

  it("models two sequential transactions competing for the last unit", () => {
    const afterFirstCommit = reserveVipStock(1, 1);
    expect(afterFirstCommit).toBe(0);
    expect(() => reserveVipStock(afterFirstCommit, 1)).toThrow(ApiError);
  });

  it("rejects missing stock, zero quantity and negative data", () => {
    expect(() => reserveVipStock(0, 1)).toThrow("stock suficiente");
    expect(() => reserveVipStock(10, 0)).toThrow(ApiError);
    expect(() => releaseVipStock(-1, 1)).toThrow(ApiError);
  });

  it("lets a deferred preorder consume stock that is not loaded yet and restores it later", () => {
    expect(applyDeferredVipStock(0, 2)).toBe(-2);
    expect(applyDeferredVipStock(10, 2)).toBe(8);
    expect(restoreAppliedVipStock(-2, 2)).toBe(0);
    expect(shouldSettleDeferredPreorder(0, "2026-09-30", "2026-09-28")).toBe(false);
    expect(shouldSettleDeferredPreorder(4, "2026-09-30", "2026-09-28")).toBe(true);
    expect(shouldSettleDeferredPreorder(0, "2026-09-28", "2026-09-28")).toBe(true);
  });
});
