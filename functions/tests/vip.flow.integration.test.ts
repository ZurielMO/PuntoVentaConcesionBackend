import { Timestamp } from "firebase-admin/firestore";
import Stripe from "stripe";
import { VipOrderStatus } from "../src/models/vip.model";
import { sendVipOrderDeliveredEmail, sendVipOrderPaidEmail } from "../src/services/vip/vip-email.service";

type Row = Record<string, any>;
const mockRows = new Map<string, Row>();
let mockAutoId = 0;

const setAtPath = (target: Row, path: string, value: any) => {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
  const key = parts[parts.length - 1];
  const sentinel = value?.constructor?.name;
  if (sentinel === "NumericIncrementTransform" || value?._methodName === "FieldValue.increment") {
    cursor[key] = Number(cursor[key] || 0) + Number(value.operand ?? value._operand ?? 0);
  } else if (sentinel === "ServerTimestampTransform" || value?._methodName === "FieldValue.serverTimestamp") {
    cursor[key] = Timestamp.now();
  } else {
    cursor[key] = value;
  }
};

const write = (path: string, data: Row, merge = false) => {
  const next = merge ? { ...(mockRows.get(path) || {}) } : {};
  Object.entries(data).forEach(([key, value]) => setAtPath(next, key, value));
  mockRows.set(path, next);
};

class MockRef {
  constructor(public path: string) {}
  get id() { return this.path.split("/").pop()!; }
  async get() { return new MockSnapshot(this); }
  async create(data: Row) {
    if (mockRows.has(this.path)) throw new Error("ALREADY_EXISTS");
    write(this.path, data);
  }
  async set(data: Row, options?: { merge?: boolean }) { write(this.path, data, options?.merge); }
  async update(data: Row) { write(this.path, data, true); }
  collection(name: string) { return new MockCollection(`${this.path}/${name}`); }
}

class MockSnapshot {
  constructor(public ref: MockRef) {}
  get id() { return this.ref.id; }
  get exists() { return mockRows.has(this.ref.path); }
  data() { return mockRows.get(this.ref.path); }
}

class MockQuery {
  constructor(
    public path: string,
    private filters: Array<[string, string, any]> = [],
    private max = Infinity,
  ) {}
  where(field: string, operator: string, value: any) {
    return new MockQuery(this.path, [...this.filters, [field, operator, value]], this.max);
  }
  limit(max: number) { return new MockQuery(this.path, this.filters, max); }
  orderBy() { return this; }
  startAfter() { return this; }
  async get() {
    const depth = this.path.split("/").length + 1;
    const docs = [...mockRows.keys()]
      .filter((path) => path.startsWith(`${this.path}/`) && path.split("/").length === depth)
      .map((path) => new MockSnapshot(new MockRef(path)))
      .filter((snapshot) => this.filters.every(([field, operator, expected]) => {
        const actual = snapshot.data()?.[field];
        if (operator === "==") return actual === expected;
        if (operator === "array-contains") return Array.isArray(actual) && actual.includes(expected);
        if (operator === "<=") return actual?.toMillis?.() <= expected?.toMillis?.();
        if (operator === ">=") return actual?.toMillis?.() >= expected?.toMillis?.();
        return false;
      }))
      .slice(0, this.max);
    return { docs, size: docs.length };
  }
}

class MockCollection extends MockQuery {
  doc(id = `auto-${++mockAutoId}`) { return new MockRef(`${this.path}/${id}`); }
}

const mockDb = {
  collection: jest.fn((name: string) => new MockCollection(name)),
  batch: jest.fn(),
  runTransaction: jest.fn(async (handler: (tx: any) => Promise<any>) => handler({
    get: (ref: MockRef) => ref.get(),
    create: (ref: MockRef, data: Row) => ref.create(data),
    set: (ref: MockRef, data: Row, options?: { merge?: boolean }) => ref.set(data, options),
    update: (ref: MockRef, data: Row) => ref.update(data),
  })),
};

const mockSessionCreate = jest.fn();
const mockSessionRetrieve = jest.fn();
const mockSessionExpire = jest.fn();
const mockRefundCreate = jest.fn();
const stripeForSignatures = new Stripe("unit_test_key_not_a_secret", {
  apiVersion: "2025-02-24.acacia" as Stripe.LatestApiVersion,
});
const mockStripe = {
  webhooks: stripeForSignatures.webhooks,
  checkout: { sessions: { create: mockSessionCreate, retrieve: mockSessionRetrieve, expire: mockSessionExpire } },
  refunds: { create: mockRefundCreate },
};

jest.mock("../src/config/firebase", () => ({ firestorePos: mockDb }));
jest.mock("../src/services/jornada.service", () => ({
  resolveJornadaPrimaria: jest.fn(async () => ({ fecha: "2026-08-26", jornadaNumero: 1 })),
}));
jest.mock("../src/services/asignacion-caja.service", () => ({ buildJornadaId: () => "jornada-1" }));
jest.mock("../src/services/inventario.service", () => ({ buildInventarioId: () => "inv-1" }));
jest.mock("../src/services/storage.service", () => ({ normalizeRecordImageUrls: (value: any) => value }));
jest.mock("../src/config/vip.config", () => {
  const actual = jest.requireActual("../src/config/vip.config");
  return {
    ...actual,
    getVipStripeClient: () => mockStripe,
    getVipBusinessDate: () => "2026-08-26",
  };
});
jest.mock("../src/services/vip/vip-email.service", () => ({
  sendVipOrderPaidEmail: jest.fn(async () => true),
  sendVipOrderDeliveredEmail: jest.fn(async () => true),
}));

const checkoutInput = () => ({
  customer: { name: "Cliente Palco", email: "cliente@example.com", phone: "4771234567" },
  delivery: { zona: "Poniente" as const, palco: "124", nivel: "Nivel 2" },
  items: [{ productId: "p1", quantity: 2, selectedOptions: ["large"], extras: ["cheese"] }],
  tip: 5,
});

const seed = (overrides: { service?: Row; location?: Row; product?: Row; stock?: Row } = {}) => {
  const now = Date.now();
  mockRows.set("vip_service_configs/2026-08-26", {
    enabled: true,
    acceptingOrders: true,
    opensAt: Timestamp.fromMillis(now - 60_000),
    closesAt: Timestamp.fromMillis(now + 60_000),
    maxActiveOrders: 5,
    activeOrderCount: 0,
    serviceFeeMinor: 2000,
    ...overrides.service,
  });
  mockRows.set("vip_locations/location-1", {
    activo: true, zonaId: "zone-1", palco: "P-10", nivel: "N-2", ...overrides.location,
  });
  mockRows.set("zonas/zone-1", { activo: true, zona: "Palcos Norte" });
  mockRows.set("products/p1", { activo: true, nombre: "Hamburguesa", precio: 999, concesion_id: "c1", ...overrides.product });
  mockRows.set("vip_product_config/p1", {
    enabled: true,
    concessionId: "c1",
    options: [{ id: "large", name: "Grande", price: 10, active: true }],
    extras: [{ id: "cheese", name: "Queso", price: 5, active: true }],
  });
  mockRows.set("concesiones/c1", { activo: true, nombre: "Restaurante Real" });
  mockRows.set("vip_concession_config/c1", { enabled: true, sucursalId: "s1" });
  mockRows.set("sucursales/s1", { activo: true, concesion_id: "c1" });
  mockRows.set("inventarios/inv-1", {
    activo: true,
    sucursal_id: "s1",
    jornada_fecha: "2026-08-26",
    jornada_numero: 1,
  });
  mockRows.set("inventarios/inv-1/productos/p1", { cantidad_final: 5, precio_jornada: 100, ...overrides.stock });
};

describe("VIP checkout/payment/refund flow with in-memory Firestore and Stripe", () => {
  beforeEach(() => {
    mockRows.clear();
    mockAutoId = 0;
    jest.clearAllMocks();
    process.env.VIP_TRACKING_SECRET = "test-secret-at-least-32-characters-long";
    process.env.STRIPE_WEBHOOK_SECRET = "unit_test_flow_webhook_secret";
    process.env.VIP_CHECKOUT_SUCCESS_URL = "https://example.com/success";
    process.env.VIP_CHECKOUT_CANCEL_URL = "https://example.com/cancel";
    mockSessionCreate.mockResolvedValue({ id: "cs_flow", url: "https://checkout.stripe.test/cs_flow" });
    mockSessionRetrieve.mockResolvedValue({
      id: "cs_flow",
      url: "https://checkout.stripe.test/cs_flow",
      payment_status: "unpaid",
      status: "open",
    });
    mockSessionExpire.mockResolvedValue({
      id: "cs_flow",
      payment_status: "unpaid",
      status: "expired",
    });
    mockRefundCreate.mockResolvedValue({ id: "re_flow", amount: 25500 });
    seed();
  });

  it("unlocks a central zone only with the shared password", async () => {
    process.env.VIP_CENTRAL_ZONE_PASSWORD = "Palcos.2026";
    const { unlockCentralZone } = await import("../src/services/vip/vip.service");
    await expect(Promise.resolve().then(() => unlockCentralZone("wrong", "Oriente"))).rejects.toMatchObject({
      code: "VIP_INVALID_ZONE_PASSWORD",
    });
    expect(unlockCentralZone("Palcos.2026", "Poniente")).toEqual({ zona: "Poniente" });
  });

  it("creates one server-priced order and atomically reserves real shared stock", async () => {
    const { createCheckout } = await import("../src/services/vip/vip.service");
    const result = await createCheckout(checkoutInput(), "checkout-key-001");
    expect(result.total).toBe(255); // (100 + 10 + 5) * 2 + 20 + 5
    expect(mockRows.get(`vip_orders/${result.orderId}`)?.delivery).toMatchObject({
      zona: "Poniente",
      palco: "124",
      nivel: "Piso 2",
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 25500 }) })],
        cancel_url: expect.stringMatching(/session_id=\{CHECKOUT_SESSION_ID\}/),
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^vip_checkout_/) }),
    );
    expect([...mockRows.values()].filter((row) => row.orderId === result.orderId && row.status === "ACTIVE")).toHaveLength(1);
  });

  it("serves only whitelisted real catalog/location fields with jornada pricing", async () => {
    const { listCatalog, listLocations } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ name: "Restaurante Real" });
    expect(catalog[0].products[0]).toMatchObject({
      name: "Hamburguesa",
      price: 100,
      available: true,
    });
    expect(catalog[0].porcentajeComision).toBeUndefined();
    mockRows.delete("inventarios/inv-1/productos/p1");
    const catalogWithoutStock = await listCatalog();
    expect(catalogWithoutStock[0].products[0].available).toBe(false);
    await expect(listLocations()).resolves.toEqual([{
      id: "location-1",
      zonaId: "zone-1",
      zona: "Palcos Norte",
      palco: "P-10",
      nivel: "N-2",
    }]);
  });

  it("serves catalog and checkout by business date without jornada RTDB", async () => {
    const { resolveJornadaPrimaria } = await import("../src/services/jornada.service");
    (resolveJornadaPrimaria as jest.Mock).mockRejectedValue(new Error("jornada should not be required"));
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({
      name: "Hamburguesa",
      price: 100,
      available: true,
    });
    await expect(createCheckout(checkoutInput(), "checkout-no-jornada")).resolves.toMatchObject({
      currency: "mxn",
    });
  });

  it("does not sell against a closed jornada inventory", async () => {
    mockRows.set("inventarios/inv-1", {
      activo: false,
      sucursal_id: "s1",
      jornada_fecha: "2026-08-26",
      jornada_numero: 1,
    });
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ available: false });
    await expect(createCheckout(checkoutInput(), "checkout-inactive-jornada")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });
  });

  it("uses the open POS inventory even when jornada_fecha is the match date, not today", async () => {
    mockRows.set("inventarios/inv-1", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: "2026-09-12",
      jornada_numero: 8,
      updatedAt: Timestamp.fromMillis(Date.now()),
    });
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ available: true, price: 100 });
    await expect(createCheckout(checkoutInput(), "checkout-match-date")).resolves.toMatchObject({
      currency: "mxn",
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
  });

  it("abandons an unpaid checkout and restores the open jornada stock", async () => {
    const { createCheckout, abandonCheckout } = await import("../src/services/vip/vip.service");
    const checkout = await createCheckout(checkoutInput(), "checkout-abandon-001");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
    const result = await abandonCheckout({
      orderId: checkout.orderId,
      trackingToken: checkout.trackingToken,
    });
    expect(result).toMatchObject({ released: true, paid: false, status: "CANCELLED" });
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.status).toBe("CANCELLED");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
    expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toBeUndefined();
    expect([...mockRows.values()].some((row) => row.tipo === "VENTA" && row.ventaId === checkout.orderId)).toBe(false);
    const again = await abandonCheckout({
      orderId: checkout.orderId,
      trackingToken: checkout.trackingToken,
    });
    expect(again.released).toBe(true);
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
    expect(mockSessionExpire).toHaveBeenCalled();
  });

  it("does not restore stock to a closed jornada and sells on the new open inventory", async () => {
    const { createCheckout, abandonCheckout } = await import("../src/services/vip/vip.service");
    const first = await createCheckout(checkoutInput(), "checkout-old-jornada");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
    mockRows.set("inventarios/inv-1", {
      activo: false,
      sucursal_id: "s1",
      jornada_fecha: "2026-08-26",
      jornada_numero: 1,
    });
    mockRows.set("inventarios/inv-1/productos/p1", { cantidad_final: 0, precio_jornada: 100 });
    mockRows.set("inventarios/inv-2", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: "2026-09-12",
      jornada_numero: 8,
      updatedAt: Timestamp.fromMillis(Date.now()),
    });
    mockRows.set("inventarios/inv-2/productos/p1", { cantidad_final: 10, precio_jornada: 100 });
    await abandonCheckout({
      orderId: first.orderId,
      trackingToken: first.trackingToken,
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
    expect(mockRows.get("inventarios/inv-2/productos/p1")?.cantidad_final).toBe(10);
    await createCheckout(checkoutInput(), "checkout-new-jornada");
    expect(mockRows.get("inventarios/inv-2/productos/p1")?.cantidad_final).toBe(8);
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
  });

  it("ignores closed inventory from another calendar day", async () => {
    mockRows.set("inventarios/inv-1", {
      activo: false,
      sucursal_id: "s1",
      jornada_fecha: "2026-08-25",
      jornada_numero: 1,
    });
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0].available).toBe(false);
    await expect(createCheckout(checkoutInput(), "checkout-other-day")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });
  });

  it("picks the highest jornada_numero for the business date", async () => {
    mockRows.set("inventarios/inv-1", {
      activo: false,
      sucursal_id: "s1",
      jornada_fecha: "2026-08-26",
      jornada_numero: 1,
    });
    mockRows.set("inventarios/inv-later", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: "2026-08-26",
      jornada_numero: 2,
    });
    mockRows.set("inventarios/inv-later/productos/p1", { cantidad_final: 8, precio_jornada: 110 });
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ available: true, price: 110 });
    await createCheckout(checkoutInput(), "checkout-latest-jornada");
    expect(mockRows.get("inventarios/inv-later/productos/p1")?.cantidad_final).toBe(6);
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
  });

  it("matches inventory stored with DD/MM/YYYY jornada_fecha for the same business day", async () => {
    mockRows.delete("inventarios/inv-1");
    mockRows.set("inventarios/inv-dmy", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: "26/08/2026",
      jornada_numero: 1,
    });
    mockRows.set("inventarios/inv-dmy/productos/p1", { cantidad_final: 4, precio_jornada: 100 });
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0].available).toBe(true);
    await createCheckout(checkoutInput(), "checkout-dmy-fecha");
    expect(mockRows.get("inventarios/inv-dmy/productos/p1")?.cantidad_final).toBe(2);
  });

  it("returns the same order/session for an idempotent checkout retry", async () => {
    const { createCheckout } = await import("../src/services/vip/vip.service");
    const first = await createCheckout(checkoutInput(), "checkout-idempotent-001");
    const second = await createCheckout(checkoutInput(), "checkout-idempotent-001");
    expect(second.orderId).toBe(first.orderId);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    expect([...mockRows.keys()].filter((path) => /^vip_orders\/[^/]+$/.test(path))).toHaveLength(1);
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
  });

  it.each([
    ["missing product", () => mockRows.delete("products/p1"), "VIP_PRODUCT_NOT_FOUND"],
    ["out of stock", () => mockRows.set("inventarios/inv-1/productos/p1", { cantidad_final: 0, precio_jornada: 100 }), "VIP_OUT_OF_STOCK"],
    ["missing inventory line", () => mockRows.delete("inventarios/inv-1/productos/p1"), "VIP_OUT_OF_STOCK"],
    ["no inventory for the day", () => mockRows.delete("inventarios/inv-1"), "VIP_OUT_OF_STOCK"],
    ["closed service", () => mockRows.set("vip_service_configs/2026-08-26", { ...mockRows.get("vip_service_configs/2026-08-26"), enabled: false }), "VIP_SERVICE_CLOSED"],
    ["capacity reached", () => mockRows.set("vip_service_configs/2026-08-26", { ...mockRows.get("vip_service_configs/2026-08-26"), activeOrderCount: 5 }), "VIP_CAPACITY_REACHED"],
  ])("rejects %s before Stripe", async (_name, mutate, code) => {
    mutate();
    const { createCheckout } = await import("../src/services/vip/vip.service");
    await expect(createCheckout(checkoutInput(), `checkout-${code}`)).rejects.toMatchObject({ code });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("confirms a signed paid event once, records deterministic sale, then refunds once", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-paid-001");
    const payload = JSON.stringify({
      id: "evt_paid_flow",
      object: "event",
      api_version: "2025-02-24.acacia",
      created: 1,
      data: { object: {
        id: "cs_flow",
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: "pi_flow",
        amount_total: 25500,
        currency: "mxn",
        metadata: { orderId: checkout.orderId, source: "VIP" },
      } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: "unit_test_flow_webhook_secret" });
    await service.processStripeWebhook(Buffer.from(payload), signature);
    const orderPath = `vip_orders/${checkout.orderId}`;
    expect(mockRows.get(orderPath)?.status).toBe("RECEIVED");
    expect(mockRows.get(orderPath)?.payment.status).toBe("PAID");
    expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)?.source).toBe("VIP");

    await expect(service.processStripeWebhook(Buffer.from(payload), signature)).resolves.toMatchObject({ duplicate: true });
    expect(sendVipOrderPaidEmail).toHaveBeenCalledTimes(1);
    expect(sendVipOrderDeliveredEmail).not.toHaveBeenCalled();
    await service.refundOrder(checkout.orderId, "Cancelación operativa", { actorId: "admin-1", actorRole: "SUPERADMIN" });
    await service.refundOrder(checkout.orderId, "Reintento", { actorId: "admin-1", actorRole: "SUPERADMIN" });
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockRows.get(orderPath)?.payment.status).toBe("REFUNDED");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
  });

  it("releases inventory and marks payment failed from a signed expired event", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-expired-001");
    const payload = JSON.stringify({
      id: "evt_expired_flow", object: "event", api_version: "2025-02-24.acacia", created: 1,
      data: { object: { id: "cs_flow", object: "checkout.session", metadata: { orderId: checkout.orderId } } },
      livemode: false, pending_webhooks: 1, request: null, type: "checkout.session.expired",
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: "unit_test_flow_webhook_secret" });
    await service.processStripeWebhook(Buffer.from(payload), signature);
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.status).toBe("PAYMENT_FAILED");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
  });

  it("auto-refunds a late payment after its inventory reservation was released", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-late-paid-001");
    const expiredPayload = JSON.stringify({
      id: "evt_late_expired", object: "event", api_version: "2025-02-24.acacia", created: 1,
      data: { object: { id: "cs_flow", object: "checkout.session", metadata: { orderId: checkout.orderId } } },
      livemode: false, pending_webhooks: 1, request: null, type: "checkout.session.expired",
    });
    await service.processStripeWebhook(
      Buffer.from(expiredPayload),
      Stripe.webhooks.generateTestHeaderString({ payload: expiredPayload, secret: "unit_test_flow_webhook_secret" }),
    );
    const paidPayload = JSON.stringify({
      id: "evt_late_paid", object: "event", api_version: "2025-02-24.acacia", created: 2,
      data: { object: {
        id: "cs_flow", object: "checkout.session", payment_status: "paid", payment_intent: "pi_late",
        amount_total: 25500, currency: "mxn", metadata: { orderId: checkout.orderId },
      } },
      livemode: false, pending_webhooks: 1, request: null, type: "checkout.session.completed",
    });
    await service.processStripeWebhook(
      Buffer.from(paidPayload),
      Stripe.webhooks.generateTestHeaderString({ payload: paidPayload, secret: "unit_test_flow_webhook_secret" }),
    );
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.payment.status).toBe("REFUNDED");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(sendVipOrderPaidEmail).not.toHaveBeenCalled();
  });

  it("tracks only with the derived secret token and masks customer email", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-track-001");
    await expect(service.getTracking(checkout.orderId, "x".repeat(43)))
      .rejects.toMatchObject({ code: "VIP_ORDER_NOT_FOUND" });
    await expect(service.getTracking(checkout.orderId, checkout.trackingToken)).resolves.toMatchObject({
      id: checkout.orderId,
      customer: { email: "c***@example.com" },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("assigns a runner transactionally and cancels an unpaid order exactly once", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-cancel-001");
    const orderPath = `vip_orders/${checkout.orderId}`;
    mockRows.get(orderPath)!.status = "RECEIVED";
    const assigned = await service.assignRunner(
      checkout.orderId,
      { runnerId: "runner-1", name: "Mesero Uno" },
      { actorId: "admin-1", actorRole: "SUPERADMIN" },
    );
    expect(assigned.runnerId).toBe("runner-1");
    // Restore unpaid status to exercise reservation cancellation semantics.
    mockRows.get(orderPath)!.status = "PENDING_PAYMENT";
    await service.cancelOrder(
      checkout.orderId,
      "Cliente solicita cancelación",
      { actorId: "admin-1", actorRole: "SUPERADMIN" },
    );
    expect(mockRows.get(orderPath)?.status).toBe("CANCELLED");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
    await expect(service.cancelOrder(
      checkout.orderId,
      "Segundo intento",
      { actorId: "admin-1", actorRole: "SUPERADMIN" },
    )).rejects.toMatchObject({ code: "VIP_INVALID_STATE_TRANSITION" });
  });

  it("builds one preparation ticket per concession plus one secure delivery ticket", async () => {
    const { getPrintData } = await import("../src/services/vip/vip.service");
    mockRows.set("vip_orders/order-print", {
      id: "order-print",
      orderNumber: "VIP-PRINT-1",
      fecha: "2026-08-26",
      jornadaId: "2026-08-26",
      customer: { name: "Cliente", email: "c@example.com", phone: null },
      delivery: { locationId: null, zonaId: "", zona: "Norte", palco: "P1", nivel: "N1", notes: null },
      items: [
        { id: "i1", name: "Uno", quantity: 1, selectedOptions: [], extras: [], notes: null },
        { id: "i2", name: "Dos", quantity: 2, selectedOptions: [], extras: [], notes: "Sin hielo" },
      ],
      fulfillments: [
        { concessionId: "c1", concessionName: "Uno", itemIds: ["i1"] },
        { concessionId: "c2", concessionName: "Dos", itemIds: ["i2"] },
      ],
      total: 300,
      currency: "mxn",
      runner: null,
      status: "RECEIVED",
      createdAt: Timestamp.now(),
    });
    const data = await getPrintData("order-print", { actorId: "admin", actorRole: "SUPERADMIN" });
    expect(data.preparationTickets).toHaveLength(2);
    expect(data.preparationTickets[0].orderId).toBe("order-print");
    expect(data.deliveryTicket.orderId).toBe("order-print");
    expect(data.deliveryTicket.itemsCount).toBe(3);
    expect(data.deliveryTicket.trackingToken).toHaveLength(43);
  });

  const actor = { actorId: "admin-1", actorRole: "SUPERADMIN" };
  const signEvent = (payload: string) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: "unit_test_flow_webhook_secret" });

  const confirmPaid = async (service: typeof import("../src/services/vip/vip.service"), orderId: string, eventId: string) => {
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      api_version: "2025-02-24.acacia",
      created: 1,
      data: { object: {
        id: "cs_flow",
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: "pi_flow",
        amount_total: 25500,
        currency: "mxn",
        metadata: { orderId, source: "VIP" },
      } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    });
    await service.processStripeWebhook(Buffer.from(payload), signEvent(payload));
  };

  it("rejects paused service, disabled products and unknown extras before Stripe", async () => {
    const { createCheckout } = await import("../src/services/vip/vip.service");
    mockRows.set("vip_service_configs/2026-08-26", {
      ...mockRows.get("vip_service_configs/2026-08-26"),
      acceptingOrders: false,
    });
    await expect(createCheckout(checkoutInput(), "checkout-paused")).rejects.toMatchObject({
      code: "VIP_SERVICE_PAUSED",
    });
    seed();
    mockRows.set("vip_product_config/p1", { ...mockRows.get("vip_product_config/p1"), enabled: false });
    await expect(createCheckout(checkoutInput(), "checkout-disabled")).rejects.toMatchObject({
      code: "VIP_PRODUCT_DISABLED",
    });
    seed();
    const unknownExtra = checkoutInput();
    unknownExtra.items[0].extras = ["not-on-menu"];
    await expect(createCheckout(unknownExtra, "checkout-extra")).rejects.toMatchObject({
      code: "VIP_PRODUCT_DISABLED",
    });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("lets only one checkout keep the last remaining unit", async () => {
    seed({ stock: { cantidad_final: 1, precio_jornada: 100 } });
    const { createCheckout } = await import("../src/services/vip/vip.service");
    const input = checkoutInput();
    input.items[0].quantity = 1;
    const winner = await createCheckout(input, "checkout-last-unit-1");
    await expect(createCheckout(input, "checkout-last-unit-2")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });
    expect(winner.orderId).toBeTruthy();
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  });

  it("releases reserved stock when Stripe session creation fails", async () => {
    mockSessionCreate.mockRejectedValueOnce(new Error("stripe unavailable"));
    const { createCheckout } = await import("../src/services/vip/vip.service");
    await expect(createCheckout(checkoutInput(), "checkout-stripe-down")).rejects.toMatchObject({
      code: "VIP_PAYMENT_FAILED",
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
  });

  it("rejects an idempotency key reused with a different cart", async () => {
    const { createCheckout } = await import("../src/services/vip/vip.service");
    await createCheckout(checkoutInput(), "checkout-conflict-001");
    const other = checkoutInput();
    other.tip = 50;
    await expect(createCheckout(other, "checkout-conflict-001")).rejects.toMatchObject({
      code: "VIP_IDEMPOTENCY_CONFLICT",
    });
  });

  it("serves catalog prices when the date has no POS inventory instead of inventing restaurants", async () => {
    mockRows.delete("inventarios/inv-1");
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ name: "Hamburguesa", price: 999, available: false });
    await expect(createCheckout(checkoutInput(), "checkout-no-inventory")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });
  });

  it("serves POS concessions and products without vip_concession_config", async () => {
    mockRows.delete("vip_concession_config/c1");
    mockRows.delete("vip_product_config/p1");
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ name: "Restaurante Real" });
    expect(catalog[0].products[0]).toMatchObject({ name: "Hamburguesa", price: 100, available: true });
    const input = checkoutInput();
    input.items[0].selectedOptions = [];
    input.items[0].extras = [];
    await expect(createCheckout(input, "checkout-pos-catalog")).resolves.toMatchObject({
      currency: "mxn",
    });
  });

  it("marks payment failed from payment_intent.payment_failed and restores stock", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-pi-failed");
    const payload = JSON.stringify({
      id: "evt_pi_failed",
      object: "event",
      api_version: "2025-02-24.acacia",
      created: 1,
      data: { object: {
        id: "pi_failed",
        object: "payment_intent",
        metadata: { orderId: checkout.orderId },
      } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "payment_intent.payment_failed",
    });
    await service.processStripeWebhook(Buffer.from(payload), signEvent(payload));
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.status).toBe("PAYMENT_FAILED");
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.payment.status).toBe("FAILED");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
  });

  it("rejects a signed paid event whose amount does not match the server total", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-amount-mismatch");
    const payload = JSON.stringify({
      id: "evt_amount_mismatch",
      object: "event",
      api_version: "2025-02-24.acacia",
      created: 1,
      data: { object: {
        id: "cs_flow",
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: "pi_mismatch",
        amount_total: 100,
        currency: "mxn",
        metadata: { orderId: checkout.orderId },
      } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    });
    await expect(service.processStripeWebhook(Buffer.from(payload), signEvent(payload)))
      .rejects.toMatchObject({ code: "VIP_PAYMENT_AMOUNT_MISMATCH" });
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.status).toBe("PENDING_PAYMENT");
  });

  it("walks valid operational transitions and rejects illegal jumps", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-transitions");
    await confirmPaid(service, checkout.orderId, "evt_paid_transitions");
    await expect(service.transitionOrder(checkout.orderId, VipOrderStatus.DELIVERED, actor))
      .rejects.toMatchObject({ code: "VIP_INVALID_STATE_TRANSITION" });
    const updated = await service.transitionOrder(checkout.orderId, VipOrderStatus.ACCEPTED, actor);
    expect(updated.status).toBe(VipOrderStatus.ON_THE_WAY);
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.status).toBe("ON_THE_WAY");
    const delivered = await service.transitionOrder(checkout.orderId, VipOrderStatus.DELIVERED, actor);
    expect(delivered.status).toBe(VipOrderStatus.DELIVERED);
    expect(sendVipOrderDeliveredEmail).toHaveBeenCalledTimes(1);
    await service.transitionOrder(checkout.orderId, VipOrderStatus.DELIVERED, actor);
    expect(sendVipOrderDeliveredEmail).toHaveBeenCalledTimes(1);
    await expect(service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor))
      .rejects.toMatchObject({ code: "VIP_INVALID_STATE_TRANSITION" });
    await expect(service.transitionOrder(checkout.orderId, VipOrderStatus.PAID, actor))
      .rejects.toMatchObject({ code: "VIP_INVALID_STATE_TRANSITION" });
  });

  it("confirms a paid Stripe session without waiting for the webhook", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-confirm-session");
    mockSessionRetrieve.mockResolvedValue({
      id: "cs_flow",
      payment_status: "paid",
      payment_intent: "pi_confirm",
      amount_total: 25500,
      currency: "mxn",
      metadata: { orderId: checkout.orderId },
    });
    const confirmed = await service.confirmCheckoutSession("cs_flow");
    expect(confirmed).toMatchObject({
      orderId: checkout.orderId,
      paid: true,
      status: VipOrderStatus.RECEIVED,
    });
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.status).toBe("RECEIVED");
    expect(sendVipOrderPaidEmail).toHaveBeenCalledTimes(1);
  });

  it("lists paid orders for the central and expires unpaid reservations", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-admin-list");
    await confirmPaid(service, checkout.orderId, "evt_paid_admin_list");
    const listed = await service.listAdminOrders({
      status: VipOrderStatus.RECEIVED,
      concessionId: "c1",
      zona: "Poniente",
      limit: 25,
    });
    expect(listed.data.some((row) => String(row.id) === checkout.orderId)).toBe(true);

    const listedByFecha = await service.listAdminOrders({
      fecha: "2026-08-26",
      zona: "Poniente",
      limit: 100,
    });
    expect(listedByFecha.data.some((row) => String(row.id) === checkout.orderId)).toBe(true);

    const orienteId = `${checkout.orderId}-oriente`;
    const paidOrder = mockRows.get(`vip_orders/${checkout.orderId}`);
    mockRows.set(`vip_orders/${orienteId}`, {
      ...paidOrder,
      id: orienteId,
      delivery: { ...paidOrder?.delivery, zona: "Oriente" },
    });
    const ponienteOnly = await service.listAdminOrders({
      fecha: "2026-08-26",
      zona: "Poniente",
      limit: 100,
    });
    expect(ponienteOnly.data.some((row) => String(row.id) === checkout.orderId)).toBe(true);
    expect(ponienteOnly.data.some((row) => String(row.id) === orienteId)).toBe(false);
    const orienteOnly = await service.listAdminOrders({
      fecha: "2026-08-26",
      zona: "Oriente",
      limit: 100,
    });
    expect(orienteOnly.data.some((row) => String(row.id) === orienteId)).toBe(true);
    expect(orienteOnly.data.some((row) => String(row.id) === checkout.orderId)).toBe(false);

    const unpaid = await service.createCheckout(checkoutInput(), "checkout-expire");
    for (const [path, row] of mockRows.entries()) {
      if (path.startsWith("vip_reservations/") && row.orderId === unpaid.orderId) {
        row.expiresAt = Timestamp.fromMillis(Date.now() - 60_000);
      }
    }
    await service.expireReservations();
    expect(mockRows.get(`vip_orders/${unpaid.orderId}`)?.status).toBe("PAYMENT_FAILED");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
  });

  it("snapshots a multi-concession cart into one payment and two preparation tickets", async () => {
    mockRows.set("products/p2", { activo: true, nombre: "Agua", precio: 20, concesion_id: "c2" });
    mockRows.set("vip_product_config/p2", { enabled: true, concessionId: "c2", options: [], extras: [] });
    mockRows.set("concesiones/c2", { activo: true, nombre: "Bar Real" });
    mockRows.set("vip_concession_config/c2", { enabled: true, sucursalId: "s2" });
    mockRows.set("sucursales/s2", { activo: true, concesion_id: "c2" });
    mockRows.set("inventarios/inv-2", {
      activo: true,
      sucursal_id: "s2",
      jornada_fecha: "2026-08-26",
      jornada_numero: 1,
    });
    mockRows.set("inventarios/inv-2/productos/p2", { cantidad_final: 8, precio_jornada: 20 });
    const { createCheckout, getPrintData } = await import("../src/services/vip/vip.service");
    const input = checkoutInput();
    input.items.push({ productId: "p2", quantity: 1, selectedOptions: [], extras: [] });
    const checkout = await createCheckout(input, "checkout-multi-001");
    expect(checkout.total).toBe(275);
    const order = mockRows.get(`vip_orders/${checkout.orderId}`);
    expect(order?.concessionIds).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(order?.fulfillments).toHaveLength(2);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    const tickets = await getPrintData(checkout.orderId, actor);
    expect(tickets.preparationTickets).toHaveLength(2);
    expect(tickets.deliveryTicket.itemsCount).toBe(3);
  });

  it("draws stock from another open local of the same concession when the preferred one is empty", async () => {
    mockRows.set("inventarios/inv-1/productos/p1", { cantidad_final: 0, precio_jornada: 100 });
    mockRows.set("sucursales/s1b", { activo: true, concesion_id: "c1", modo_operacion: "POS" });
    mockRows.set("inventarios/inv-s1b", {
      activo: true,
      sucursal_id: "s1b",
      jornada_fecha: "2026-08-26",
      jornada_numero: 1,
      updatedAt: Timestamp.fromMillis(Date.now()),
    });
    mockRows.set("inventarios/inv-s1b/productos/p1", { cantidad_final: 7, precio_jornada: 120 });
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ available: true, price: 120 });
    const checkout = await createCheckout(checkoutInput(), "checkout-other-local");
    expect(mockRows.get("inventarios/inv-s1b/productos/p1")?.cantidad_final).toBe(5);
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
    const order = mockRows.get(`vip_orders/${checkout.orderId}`);
    expect(order?.items[0]).toMatchObject({ sucursalId: "s1b", inventoryId: "inv-s1b" });
    expect(order?.fulfillments[0]).toMatchObject({ sucursalId: "s1b", inventoryId: "inv-s1b" });
  });

  it("never draws a concession product from another concession inventory", async () => {
    mockRows.set("inventarios/inv-1/productos/p1", { cantidad_final: 0, precio_jornada: 100 });
    mockRows.set("concesiones/c2", { activo: true, nombre: "Bar Real" });
    mockRows.set("vip_concession_config/c2", { enabled: true, sucursalId: "s2" });
    mockRows.set("sucursales/s2", { activo: true, concesion_id: "c2" });
    mockRows.set("inventarios/inv-2", {
      activo: true,
      sucursal_id: "s2",
      jornada_fecha: "2026-08-26",
      jornada_numero: 1,
    });
    mockRows.set("inventarios/inv-2/productos/p1", { cantidad_final: 20, precio_jornada: 50 });
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ available: false });
    await expect(createCheckout(checkoutInput(), "checkout-cross-concession")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });
    expect(mockRows.get("inventarios/inv-2/productos/p1")?.cantidad_final).toBe(20);
  });

  it("prefers today's open inventory over a newer leftover header from another match", async () => {
    const { getVipBusinessDate } = await import("../src/config/vip.config");
    const today = getVipBusinessDate();
    mockRows.set("inventarios/inv-1", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: today,
      jornada_numero: 2,
      updatedAt: Timestamp.fromMillis(Date.now() - 60_000),
    });
    mockRows.set("inventarios/inv-fem", {
      activo: true,
      sucursal_id: "s1",
      rama: "femenil",
      jornada_fecha: "2026-08-20",
      jornada_numero: 6,
      updatedAt: Timestamp.fromMillis(Date.now()),
    });
    mockRows.set("inventarios/inv-fem/productos/p1", { cantidad_final: 99, precio_jornada: 50 });
    const { createCheckout } = await import("../src/services/vip/vip.service");
    const checkout = await createCheckout(checkoutInput(), "checkout-rama-date");
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
    expect(mockRows.get("inventarios/inv-fem/productos/p1")?.cantidad_final).toBe(99);
    expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.items[0]).toMatchObject({ inventoryId: "inv-1" });
  });

  it("rejects checkout without a valid floor for the selected zone", async () => {
    const { createCheckout } = await import("../src/services/vip/vip.service");
    const input = checkoutInput();
    input.delivery.nivel = "Piso 3";
    await expect(createCheckout(input, "checkout-bad-floor")).rejects.toMatchObject({
      code: "VIP_INVALID_LOCATION",
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
  });
});
