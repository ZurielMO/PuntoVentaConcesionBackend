import request from "supertest";
import app from "../src/app";

describe("VIP route boundary security", () => {
  it("retires the unsafe direct order creation route", async () => {
    const response = await request(app).post("/api/vip/orders").send({ total: 1 });
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("VIP_CHECKOUT_REQUIRED");
  });

  it("rejects manipulated checkout totals before touching services", async () => {
    const response = await request(app).post("/api/vip/checkout").send({
      customer: { name: "Cliente", email: "cliente@example.com" },
      delivery: { zona: "Poniente", palco: "124" },
      items: [{ productId: "p1", quantity: 1, unitPrice: 1 }],
      total: 1,
    });
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it("rejects checkout confirm without a Stripe session id", async () => {
    const response = await request(app).post("/api/vip/checkout/confirm").send({});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VIP_INVALID_REQUEST");
  });

  it("rejects checkout abandon without a session or tracking token", async () => {
    const response = await request(app).post("/api/vip/checkout/abandon").send({ orderId: "order-1" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VIP_INVALID_REQUEST");
  });

  it("requires a Stripe signature before webhook processing", async () => {
    const response = await request(app)
      .post("/api/vip/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ id: "evt_fake" }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VIP_INVALID_WEBHOOK_SIGNATURE");
  });

  it("protects all admin order routes with existing auth", async () => {
    const response = await request(app).get("/api/vip/admin/orders");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
  });

  it("protects central zone unlock with existing auth", async () => {
    const response = await request(app).post("/api/vip/admin/central-zone/unlock").send({
      password: "Palcos.2026",
      zona: "Oriente",
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
  });

  it.each([
    ["patch", "/api/vip/admin/orders/order-1/status"],
    ["patch", "/api/vip/admin/orders/order-1/runner"],
    ["post", "/api/vip/admin/orders/order-1/cancel"],
    ["post", "/api/vip/admin/orders/order-1/refund"],
    ["get", "/api/vip/admin/orders/order-1/print-data"],
  ] as const)("%s %s requires staff auth", async (method, path) => {
    const response = await request(app)[method](path)
      .send({ status: "ACCEPTED", reason: "cancelación", runnerId: "r1", name: "Mesero" });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
  });

  it("rejects tracking without a high-entropy token before loading any order", async () => {
    const missing = await request(app).get("/api/vip/orders/order-1/tracking");
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VIP_INVALID_TRACKING_TOKEN");
    const short = await request(app).get("/api/vip/orders/order-1/tracking").query({ token: "VIP-001" });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe("VIP_INVALID_TRACKING_TOKEN");
  });
});
