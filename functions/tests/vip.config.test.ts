import {
  applyVipServiceMarkupMinor,
  buildTrackingToken,
  getVipBusinessDate,
  getVipServiceFeePercent,
  minorToMoney,
  moneyToMinor,
  resolveVipReturnUrls,
  sha256,
  verifyTrackingToken,
} from "../src/config/vip.config";

describe("VIP configuration helpers", () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, VIP_TRACKING_SECRET: "test-secret-at-least-32-characters-long" };
  });
  afterAll(() => { process.env = original; });

  it("converts money through integer minor units", () => {
    expect(moneyToMinor(20)).toBe(2000);
    expect(moneyToMinor(99.999)).toBe(10000);
    expect(minorToMoney(12345)).toBe(123.45);
  });

  it("builds deterministic order-bound tracking tokens and stores only a hash", () => {
    const token = buildTrackingToken("order-1");
    expect(token).not.toContain("order-1");
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(buildTrackingToken("order-1")).toBe(token);
    expect(buildTrackingToken("order-2")).not.toBe(token);
    expect(verifyTrackingToken("order-1", token)).toBe(true);
    expect(verifyTrackingToken("order-2", token)).toBe(false);
    expect(sha256(token)).toHaveLength(64);
  });

  it("returns localhost VIP pages while running locally even if production URLs are set", () => {
    process.env.IS_LOCAL = "true";
    process.env.NODE_ENV = "development";
    delete process.env.K_SERVICE;
    delete process.env.FUNCTION_NAME;
    process.env.VIP_CHECKOUT_SUCCESS_URL = "https://concesiones.clubleon.mx/servicio-palcos/pago/exito?session_id={CHECKOUT_SESSION_ID}";
    process.env.VIP_CHECKOUT_CANCEL_URL = "https://concesiones.clubleon.mx/servicio-palcos/pago/cancelado";
    expect(resolveVipReturnUrls()).toEqual({
      successUrl: "http://localhost:9002/servicio-palcos/pago/exito?cs={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:9002/servicio-palcos/pago/cancelado",
    });
    expect(resolveVipReturnUrls("http://localhost:9002")).toEqual({
      successUrl: "http://localhost:9002/servicio-palcos/pago/exito?cs={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:9002/servicio-palcos/pago/cancelado",
    });
  });

  it("builds return URLs from an allowed Origin header even without IS_LOCAL", () => {
    delete process.env.IS_LOCAL;
    process.env.VIP_CHECKOUT_SUCCESS_URL = "https://concesiones.clubleon.mx/servicio-palcos/pago/exito?session_id={CHECKOUT_SESSION_ID}";
    process.env.VIP_CHECKOUT_CANCEL_URL = "https://concesiones.clubleon.mx/servicio-palcos/pago/cancelado";
    expect(resolveVipReturnUrls("http://localhost:9002")).toEqual({
      successUrl: "http://localhost:9002/servicio-palcos/pago/exito?cs={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:9002/servicio-palcos/pago/cancelado",
    });
  });

  it("applies a 15% guest markup in minor units", () => {
    delete process.env.VIP_SERVICE_FEE_PERCENT;
    expect(getVipServiceFeePercent()).toBe(15);
    expect(applyVipServiceMarkupMinor(10000)).toBe(11500);
    expect(applyVipServiceMarkupMinor(11500)).toBe(13225);
    expect(minorToMoney(applyVipServiceMarkupMinor(moneyToMinor(100)))).toBe(115);
  });

  it("uses America/Mexico_City calendar date, not jornada RTDB", () => {
    expect(getVipBusinessDate(new Date("2026-08-27T04:30:00Z"))).toBe("2026-08-26");
    expect(getVipBusinessDate(new Date("2026-08-27T06:30:00Z"))).toBe("2026-08-27");
  });
});
