import { VipOrderStatus } from "../src/models/vip.model";
import {
  vipAdminListSchema,
  vipCancelSchema,
  vipCentralZoneUnlockSchema,
  vipCheckoutSchema,
  vipConfirmSessionSchema,
  vipAbandonCheckoutSchema,
  vipRunnerSchema,
  vipStatusSchema,
  vipTrackingQuerySchema,
} from "../src/middleware/validators/vip.validator";

const checkout = () => ({
  customer: { name: "Cliente Palco", email: "cliente@example.com", phone: "4771234567" },
  delivery: { zona: "Poniente", palco: "124", nivel: "Piso 2" },
  items: [{ productId: "producto-real-1", quantity: 2, selectedOptions: [], extras: [] }],
  tip: 25,
});

describe("VIP request schemas", () => {
  it("accepts the minimal valid server-priced checkout", () => {
    expect(vipCheckoutSchema.parse(checkout())).toMatchObject({
      tip: 25,
      delivery: { zona: "Poniente", palco: "124", nivel: "Piso 2" },
    });
  });

  it("normalizes floor aliases and accepts Oriente piso 3", () => {
    const body = checkout();
    body.delivery.nivel = "Nivel 2";
    expect(vipCheckoutSchema.parse(body).delivery.nivel).toBe("Piso 2");
    const oriente = checkout();
    oriente.delivery.zona = "Oriente";
    oriente.delivery.nivel = "3";
    expect(vipCheckoutSchema.parse(oriente).delivery.nivel).toBe("Piso 3");
  });

  it.each([
    ["quantity zero", (body: any) => { body.items[0].quantity = 0; }],
    ["negative quantity", (body: any) => { body.items[0].quantity = -1; }],
    ["invalid email", (body: any) => { body.customer.email = "not-email"; }],
    ["missing phone", (body: any) => { delete body.customer.phone; }],
    ["short phone", (body: any) => { body.customer.phone = "123"; }],
    ["missing palco", (body: any) => { delete body.delivery.palco; }],
    ["missing piso", (body: any) => { delete body.delivery.nivel; }],
    ["piso 3 in Poniente", (body: any) => { body.delivery.nivel = "Piso 3"; }],
    ["piso 4 in Oriente", (body: any) => { body.delivery.zona = "Oriente"; body.delivery.nivel = "Piso 4"; }],
    ["invalid zona", (body: any) => { body.delivery.zona = "Norte"; }],
    ["free text zona", (body: any) => { body.delivery.zona = "Palcos VIP"; }],
    ["empty product id", (body: any) => { body.items[0].productId = ""; }],
  ])("rejects %s", (_name, mutate) => {
    const body = checkout();
    mutate(body);
    expect(vipCheckoutSchema.safeParse(body).success).toBe(false);
  });

  it("rejects client-provided prices instead of trusting them", () => {
    const body: any = checkout();
    body.items[0].unitPrice = 1;
    body.total = 1;
    expect(vipCheckoutSchema.safeParse(body).success).toBe(false);
  });

  it("requires a high-entropy tracking token shape", () => {
    expect(vipTrackingQuerySchema.safeParse({ token: "short" }).success).toBe(false);
    expect(vipTrackingQuerySchema.safeParse({ token: "a".repeat(43) }).success).toBe(true);
  });

  it("normalizes admin pagination and requires a stadium zone", () => {
    expect(vipAdminListSchema.parse({ limit: "50", zona: "Poniente" }).limit).toBe(50);
    expect(vipAdminListSchema.safeParse({ limit: 101, zona: "Poniente" }).success).toBe(false);
    expect(vipAdminListSchema.safeParse({ limit: "50" }).success).toBe(false);
    expect(vipAdminListSchema.safeParse({ zona: "Norte" }).success).toBe(false);
    expect(vipRunnerSchema.safeParse({ runnerId: "r1", name: "Mesero VIP" }).success).toBe(true);
  });

  it("unlocks a central zone only with Oriente or Poniente", () => {
    expect(vipCentralZoneUnlockSchema.parse({ password: "Palcos.2026", zona: "Oriente" })).toEqual({
      password: "Palcos.2026",
      zona: "Oriente",
    });
    expect(vipCentralZoneUnlockSchema.safeParse({ password: "x", zona: "Norte" }).success).toBe(false);
    expect(vipCentralZoneUnlockSchema.safeParse({ zona: "Poniente" }).success).toBe(false);
  });

  it("rejects extras/options sent as priced objects instead of server ids", () => {
    const body: any = checkout();
    body.items[0].extras = [{ id: "cheese", price: 1 }];
    expect(vipCheckoutSchema.safeParse(body).success).toBe(false);
  });

  it("validates operational status changes, confirm session ids and cancel reasons", async () => {
    expect(vipStatusSchema.parse({ status: VipOrderStatus.ACCEPTED }).status).toBe("ACCEPTED");
    expect(vipStatusSchema.safeParse({ status: "COOKING" }).success).toBe(false);
    expect(vipCancelSchema.parse({ reason: "Producto agotado" }).reason).toContain("agotado");
    expect(vipCancelSchema.safeParse({ reason: "no" }).success).toBe(false);
    expect(vipConfirmSessionSchema.safeParse({ sessionId: "cs_test_abc123xyz" }).success).toBe(true);
    expect(vipConfirmSessionSchema.safeParse({ sessionId: "not-a-session" }).success).toBe(false);
    expect(vipAbandonCheckoutSchema.safeParse({ sessionId: "cs_test_abc123xyz" }).success).toBe(true);
    expect(vipAbandonCheckoutSchema.safeParse({
      orderId: "order-1",
      trackingToken: "a".repeat(43),
    }).success).toBe(true);
    expect(vipAbandonCheckoutSchema.safeParse({ orderId: "order-1" }).success).toBe(false);
    expect(vipAbandonCheckoutSchema.safeParse({}).success).toBe(false);
  });
});
