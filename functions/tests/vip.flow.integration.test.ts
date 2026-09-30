import { Timestamp } from "firebase-admin/firestore";
import Stripe from "stripe";
import { VipOrderStatus } from "../src/models/vip.model";
import { VIP_LEGAL_DOCUMENT_VERSION } from "../src/middleware/validators/vip.validator";
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

const mockGetJornadaActiva = jest.fn(async (): Promise<Record<string, Row>> => ({}));
const mockBusinessDate = jest.fn(() => "2026-08-26");

jest.mock("../src/config/firebase", () => ({ firestorePos: mockDb }));
jest.mock("../src/services/jornada.service", () => ({
  resolveJornadaPrimaria: jest.fn(async () => ({ fecha: "2026-08-26", jornadaNumero: 1 })),
  getJornadaActiva: () => mockGetJornadaActiva(),
}));
jest.mock("../src/services/asignacion-caja.service", () => ({
  buildJornadaId: () => "jornada-1",
  ramaFromInventario: (data: any, inventarioId?: string | null) => {
    const rawRama = data?.rama;
    if (rawRama === "femenil" || rawRama === "varonil") return rawRama;
    const id = String(inventarioId ?? "");
    // Cubrimos el caso legacy donde el id trae "__femenil".
    if (/(?:^|__)femenil(?:__|$)/i.test(id) || /femenil/i.test(id)) return "femenil";
    return "varonil";
  },
}));
jest.mock("../src/services/inventario.service", () => ({ buildInventarioId: () => "inv-1" }));
jest.mock("../src/services/storage.service", () => ({ normalizeRecordImageUrls: (value: any) => value }));
jest.mock("../src/config/vip.config", () => {
  const actual = jest.requireActual("../src/config/vip.config");
  return {
    ...actual,
    getVipStripeClient: () => mockStripe,
    getVipBusinessDate: () => mockBusinessDate(),
  };
});
jest.mock("../src/services/vip/vip-email.service", () => ({
  sendVipOrderPaidEmail: jest.fn(async () => true),
  sendVipOrderDeliveredEmail: jest.fn(async () => true),
  sendVipPreorderOnTheWayEmail: jest.fn(async () => true),
}));

const checkoutInput = () => ({
  customer: { name: "Cliente Palco", email: "cliente@example.com", phone: "4771234567" },
  delivery: { zona: "Poniente" as const, palco: "124", nivel: "Nivel 2" },
  items: [{ productId: "p1", quantity: 2, selectedOptions: ["large"], extras: ["cheese"] }],
  tip: 5,
  legalAcceptance: { accepted: true as const, version: VIP_LEGAL_DOCUMENT_VERSION },
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
  beforeEach(async () => {
    mockRows.clear();
    mockAutoId = 0;
    jest.clearAllMocks();
    mockBusinessDate.mockImplementation(() => "2026-08-26");
    mockGetJornadaActiva.mockImplementation(async () => ({}));
    (await import("../src/services/vip/vip-preorder.service")).clearVipPreorderCache();
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
    mockRefundCreate.mockResolvedValue({ id: "re_flow", amount: 26450 });
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
    expect(result.total).toBe(264.5); // (100 + 10 + 5) * 2 + cargo 34.50, sin propina
    expect(mockRows.get(`vip_orders/${result.orderId}`)?.delivery).toMatchObject({
      zona: "Poniente",
      palco: "124",
      nivel: "Piso 2",
    });
    expect(mockRows.get(`vip_orders/${result.orderId}`)?.legalAcceptance).toMatchObject({
      version: VIP_LEGAL_DOCUMENT_VERSION,
      documents: ["terminos", "aviso-de-privacidad", "cookies"],
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 26450 }) })],
        cancel_url: expect.stringMatching(/cs=\{CHECKOUT_SESSION_ID\}/),
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

  it("rejects immediate delivery when the open inventory belongs to another match", async () => {
    mockRows.set("inventarios/inv-1", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: "2026-09-12",
      jornada_numero: 8,
      updatedAt: Timestamp.fromMillis(Date.now()),
    });
    const { listCatalog, createCheckout, getPublicSalesStatus } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ available: false });
    await expect(getPublicSalesStatus()).resolves.toMatchObject({
      acceptingOrders: true,
      matchDay: false,
      liveOrdersOpen: false,
    });
    await expect(createCheckout(checkoutInput(), "checkout-match-date")).rejects.toMatchObject({
      code: "VIP_NOT_MATCH_DAY",
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
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

  it("does not restore stock to a closed jornada or sell another match inventory", async () => {
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
    await expect(createCheckout(checkoutInput(), "checkout-new-jornada")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });
    expect(mockRows.get("inventarios/inv-2/productos/p1")?.cantidad_final).toBe(10);
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
      code: "VIP_NOT_MATCH_DAY",
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
    ["no inventory for the day", () => mockRows.delete("inventarios/inv-1"), "VIP_NOT_MATCH_DAY"],
    ["closed service", () => mockRows.set("vip_service_configs/2026-08-26", { ...mockRows.get("vip_service_configs/2026-08-26"), enabled: false }), "VIP_SERVICE_CLOSED"],
    ["capacity reached", () => mockRows.set("vip_service_configs/2026-08-26", { ...mockRows.get("vip_service_configs/2026-08-26"), activeOrderCount: 5 }), "VIP_CAPACITY_REACHED"],
  ])("rejects %s before Stripe", async (_name, mutate, code) => {
    mutate();
    const { createCheckout } = await import("../src/services/vip/vip.service");
    await expect(createCheckout(checkoutInput(), `checkout-${code}`)).rejects.toMatchObject({ code });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("rejects an immediate sale when the open jornada has no product line", async () => {
    mockRows.delete("inventarios/inv-1/productos/p1");
    const { listCatalog, createCheckout } = await import("../src/services/vip/vip.service");
    const catalog = await listCatalog();
    expect(catalog[0].products[0]).toMatchObject({ available: false, awaitingInventory: true });
    await expect(createCheckout(checkoutInput(), "checkout-awaiting-line")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockRows.has("inventarios/inv-1/productos/p1")).toBe(false);
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
        amount_total: 26450,
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
        amount_total: 26450, currency: "mxn", metadata: { orderId: checkout.orderId },
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
        amount_total: 26450,
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
      code: "VIP_NOT_MATCH_DAY",
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

  it("closes public sales with the zone password and still fulfills paid orders", async () => {
    process.env.VIP_CENTRAL_ZONE_PASSWORD = "Palcos.2026";
    const service = await import("../src/services/vip/vip.service");
    await expect(service.getPublicSalesStatus()).resolves.toEqual({
      acceptingOrders: true,
      matchDay: true,
      liveOrdersOpen: true,
      preordersEnabled: true,
      preordersOpen: false,
    });

    const checkout = await service.createCheckout(checkoutInput(), "checkout-public-sales");
    await confirmPaid(service, checkout.orderId, "evt_paid_public_sales");
    const before = { ...mockRows.get("vip_service_configs/2026-08-26") };
    await expect(service.setPublicSalesStatus("wrong", false, "admin-1")).rejects.toMatchObject({
      code: "VIP_INVALID_ZONE_PASSWORD",
    });
    expect(mockRows.get("vip_service_configs/2026-08-26")).toEqual(before);

    await service.setPublicSalesStatus("Palcos.2026", false, "admin-1");
    const paused = mockRows.get("vip_service_configs/2026-08-26");
    expect(paused?.acceptingOrders).toBe(false);
    expect(paused?.activeOrderCount).toBe(before.activeOrderCount);
    expect(paused?.enabled).toBe(true);
    expect(paused?.maxActiveOrders).toBe(5);
    expect(paused?.updatedBy).toBe("admin-1");

    const stripeCalls = mockSessionCreate.mock.calls.length;
    await expect(service.createCheckout(checkoutInput(), "checkout-public-sales-closed")).rejects.toMatchObject({
      code: "VIP_SERVICE_PAUSED",
    });
    expect(mockSessionCreate).toHaveBeenCalledTimes(stripeCalls);

    const accepted = await service.transitionOrder(checkout.orderId, VipOrderStatus.ACCEPTED, actor);
    expect(accepted.status).toBe(VipOrderStatus.ON_THE_WAY);
    const delivered = await service.transitionOrder(checkout.orderId, VipOrderStatus.DELIVERED, actor);
    expect(delivered.status).toBe(VipOrderStatus.DELIVERED);

    const countAfterDelivery = mockRows.get("vip_service_configs/2026-08-26")?.activeOrderCount;
    await service.setPublicSalesStatus("Palcos.2026", true, "admin-1");
    const reopened = mockRows.get("vip_service_configs/2026-08-26");
    expect(reopened?.acceptingOrders).toBe(true);
    expect(reopened?.activeOrderCount).toBe(countAfterDelivery);
    expect(reopened?.maxActiveOrders).toBe(5);
    await expect(service.getPublicSalesStatus()).resolves.toEqual({
      acceptingOrders: true,
      matchDay: true,
      liveOrdersOpen: true,
      preordersEnabled: true,
      preordersOpen: false,
    });
  });

  it("limits preorder windows to 50 minutes around the active jornada kickoff", async () => {
    mockBusinessDate.mockImplementation(() => "2026-09-28");
    mockGetJornadaActiva.mockImplementation(async () => ({
      "varonil:Jornada12": {
        activo: true,
        rama: "varonil",
        jornada: 12,
        fecha: "17/10/2027",
        hora: "19:00",
        equipo_local: "León",
        equipo_visitante: "America",
        estadio: "León",
      },
    }));
    const preorder = await import("../src/services/vip/vip-preorder.service");
    preorder.clearVipPreorderCache();
    const availability = await preorder.getPreorderAvailability("Poniente");
    expect(availability.matches).toHaveLength(1);
    expect(availability.matches[0]).toMatchObject({
      jornadaNumero: 12,
      matchDate: "2027-10-17",
      matchLabel: "León vs America",
    });
    expect(availability.matches[0].windows.map((window) => window.label)).toEqual([
      "18:10 – 18:35", "18:40 – 19:05", "19:10 – 19:35",
    ]);
  });

  it("keeps the cached jornada when acreditaciones is unavailable", async () => {
    mockBusinessDate.mockImplementation(() => "2026-09-28");
    mockGetJornadaActiva.mockRejectedValue(new Error("acreditaciones unavailable"));
    mockRows.set("jornada_activa_cache/varonil", {
      activo: true,
      rama: "varonil",
      jornada: 12,
      fecha: "17/10/2027",
      hora: "19:00",
      equipo_local: "León",
      equipo_visitante: "America",
      estadio: "León",
    });
    const preorder = await import("../src/services/vip/vip-preorder.service");
    preorder.clearVipPreorderCache();
    const availability = await preorder.getPreorderAvailability("Poniente");
    expect(availability.matches).toHaveLength(1);
    expect(availability.matches[0]).toMatchObject({
      jornadaNumero: 12,
      matchDate: "2027-10-17",
      matchLabel: "León vs America",
    });
    expect(availability.matches[0].windows.map((window) => window.label)).toEqual([
      "18:10 – 18:35", "18:40 – 19:05", "19:10 – 19:35",
    ]);
  });

  it("does not revive a cached jornada when acreditaciones reports none active", async () => {
    mockBusinessDate.mockImplementation(() => "2026-09-28");
    mockGetJornadaActiva.mockImplementation(async () => ({}));
    mockRows.set("jornada_activa_cache/varonil", {
      activo: true,
      rama: "varonil",
      jornada: 12,
      fecha: "17/10/2027",
      hora: "19:00",
      equipo_local: "León",
      equipo_visitante: "America",
    });
    const preorder = await import("../src/services/vip/vip-preorder.service");
    preorder.clearVipPreorderCache();
    const availability = await preorder.getPreorderAvailability("Poniente");
    expect(availability.matches).toHaveLength(0);
  });

  it("fills the kickoff from cache when the live jornada has no start time", async () => {
    mockBusinessDate.mockImplementation(() => "2026-09-28");
    mockGetJornadaActiva.mockImplementation(async () => ({
      "varonil:Jornada12": {
        activo: true,
        rama: "varonil",
        jornada: 12,
        fecha: "2027-10-17",
      },
    }));
    mockRows.set("jornada_activa_cache/varonil", {
      activo: true,
      rama: "varonil",
      jornada: 12,
      fecha: "17/10/2027",
      hora: "19:00",
      equipo_local: "León",
      equipo_visitante: "America",
    });
    const preorder = await import("../src/services/vip/vip-preorder.service");
    preorder.clearVipPreorderCache();
    const availability = await preorder.getPreorderAvailability("Poniente");
    expect(availability.matches[0]).toMatchObject({ matchLabel: "León vs America" });
    expect(availability.matches[0].windows.map((window) => window.start)).toEqual(["18:10", "18:40", "19:10"]);
  });

  it("opens immediate delivery on a scheduled match day and closes it on any other day", async () => {
    const service = await import("../src/services/vip/vip.service");
    mockBusinessDate.mockImplementation(() => "2026-08-27");
    mockRows.set("vip_service_configs/2026-08-27", {
      enabled: true,
      acceptingOrders: true,
      maxActiveOrders: 5,
      activeOrderCount: 0,
    });
    await expect(service.getPublicSalesStatus()).resolves.toMatchObject({
      acceptingOrders: true,
      matchDay: false,
      liveOrdersOpen: false,
    });
    await expect(service.createCheckout(checkoutInput(), "checkout-not-match-day")).rejects.toMatchObject({
      code: "VIP_NOT_MATCH_DAY",
    });
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);

    mockGetJornadaActiva.mockImplementation(async () => ({
      "varonil:Jornada9": {
        activo: true,
        rama: "varonil",
        jornada: 9,
        fecha: "27/08/2026",
        hora: "21:00",
        equipo_local: "León",
        equipo_visitante: "América",
      },
    }));
    (await import("../src/services/vip/vip-preorder.service")).clearVipPreorderCache();
    await expect(service.getPublicSalesStatus()).resolves.toMatchObject({
      matchDay: true,
      liveOrdersOpen: true,
    });
    mockRows.set("inventarios/inv-match", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: "2026-08-27",
      jornada_numero: 9,
    });
    mockRows.set("inventarios/inv-match/productos/p1", { cantidad_final: 6, precio_jornada: 100 });
    await service.createCheckout(checkoutInput(), "checkout-match-day");
    expect(mockRows.get("inventarios/inv-match/productos/p1")?.cantidad_final).toBe(4);
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);

    mockRows.set("vip_service_configs/2026-08-27", {
      enabled: true,
      acceptingOrders: false,
      maxActiveOrders: 5,
      activeOrderCount: 0,
    });
    await expect(service.getPublicSalesStatus()).resolves.toMatchObject({
      acceptingOrders: false,
      matchDay: true,
      liveOrdersOpen: false,
    });
    await expect(service.createCheckout(checkoutInput(), "checkout-switch-off-match-day")).rejects.toMatchObject({
      code: "VIP_SERVICE_PAUSED",
    });
    expect(mockRows.get("inventarios/inv-match/productos/p1")?.cantidad_final).toBe(4);
  });

  it("reads a closed default config and copies its limits onto the business date", async () => {
    process.env.VIP_CENTRAL_ZONE_PASSWORD = "Palcos.2026";
    mockRows.delete("vip_service_configs/2026-08-26");
    mockRows.set("vip_service_configs/default", {
      enabled: true,
      acceptingOrders: false,
      maxActiveOrders: 9,
      activeOrderCount: 2,
    });
    const service = await import("../src/services/vip/vip.service");
    await expect(service.getPublicSalesStatus()).resolves.toEqual({
      acceptingOrders: false,
      matchDay: true,
      liveOrdersOpen: false,
      preordersEnabled: true,
      preordersOpen: false,
    });
    await expect(service.createCheckout(checkoutInput(), "checkout-default-closed")).rejects.toMatchObject({
      code: "VIP_SERVICE_PAUSED",
    });
    await service.setPublicSalesStatus("Palcos.2026", true, "admin-2");
    expect(mockRows.get("vip_service_configs/default")).toMatchObject({
      acceptingOrders: false,
      activeOrderCount: 2,
    });
    expect(mockRows.get("vip_service_configs/2026-08-26")).toMatchObject({
      acceptingOrders: true,
      enabled: true,
      maxActiveOrders: 9,
      activeOrderCount: 2,
      updatedBy: "admin-2",
      fecha: "2026-08-26",
    });
  });

  it("confirms a paid Stripe session without waiting for the webhook", async () => {
    const service = await import("../src/services/vip/vip.service");
    const checkout = await service.createCheckout(checkoutInput(), "checkout-confirm-session");
    mockSessionRetrieve.mockResolvedValue({
      id: "cs_flow",
      payment_status: "paid",
      payment_intent: "pi_confirm",
      amount_total: 26450,
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

    // Al confirmar el pago (cuando se registra el movimiento tipo VENTA),
    // debe quedar trazabilidad completa del antes/después de inventario.
    const ventaMovs = [...mockRows.values()].filter(
      (row) => row.tipo === "VENTA" && row.ventaId === checkout.orderId,
    );
    expect(ventaMovs).toHaveLength(1);
    expect(ventaMovs[0].cantidad).toBe(-2);
    expect(ventaMovs[0].cantidad_anterior).toBe(5);
    expect(ventaMovs[0].cantidad_nueva).toBe(3);

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
    expect(checkout.total).toBe(287.5);
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

  it("never sells using femenil inventory when varonil is open but out of stock", async () => {
    const { getVipBusinessDate } = await import("../src/config/vip.config");
    const today = getVipBusinessDate();

    // Varonil abierto pero sin stock suficiente
    mockRows.set("inventarios/inv-1", {
      activo: true,
      sucursal_id: "s1",
      jornada_fecha: today,
      jornada_numero: 2,
      updatedAt: Timestamp.fromMillis(Date.now() - 60_000),
    });
    mockRows.set("inventarios/inv-1/productos/p1", { cantidad_final: 0, precio_jornada: 100 });

    // Femenil abierto con stock positivo (NO debe ser usado)
    mockRows.set("inventarios/inv-fem", {
      activo: true,
      sucursal_id: "s1",
      rama: "femenil",
      jornada_fecha: today,
      jornada_numero: 6,
      updatedAt: Timestamp.fromMillis(Date.now()),
    });
    mockRows.set("inventarios/inv-fem/productos/p1", { cantidad_final: 99, precio_jornada: 50 });

    const { createCheckout } = await import("../src/services/vip/vip.service");
    await expect(createCheckout(checkoutInput(), "checkout-varonil-only-outofstock")).rejects.toMatchObject({
      code: "VIP_OUT_OF_STOCK",
    });

    // Validación extra: el stock femenil no debe tocarse si se rechazó antes de reservar
    expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
    expect(mockRows.get("inventarios/inv-fem/productos/p1")?.cantidad_final).toBe(99);
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

  describe("preventa de pedidos", () => {
    const stadiumDate = (millis: number) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(millis)).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const today = stadiumDate(Date.now());
    const matchDate = stadiumDate(Date.now() + 3 * 24 * 60 * 60_000);
    const slotPath = (window: string) => `vip_preorder_slots/jornada-1__Poniente__${window}`;
    const preorderInput = (windowStart = "18:10") => ({
      ...checkoutInput(),
      preorder: { matchId: "jornada-1", windowStart },
    });

    beforeEach(() => {
      mockBusinessDate.mockImplementation(() => today);
      mockGetJornadaActiva.mockImplementation(async () => ({
        "varonil:Jornada11": {
          activo: true,
          rama: "varonil",
          jornada: 11,
          fecha: matchDate,
          hora: "19:00 hrs",
          equipo_local: "León",
          equipo_visitante: "Puebla",
          estadio: "Estadio León",
        },
      }));
    });

    it("offers only future delivery windows of at least 25 minutes for the active match", async () => {
      const { getPreorderAvailability } = await import("../src/services/vip/vip-preorder.service");
      const availability = await getPreorderAvailability("Poniente");
      expect(availability.enabled).toBe(true);
      expect(availability.matches).toHaveLength(1);
      const [match] = availability.matches;
      expect(match).toMatchObject({ matchId: "jornada-1", jornadaNumero: 11, matchLabel: "León vs Puebla" });
      expect(match.windows.map((row) => row.label)).toEqual([
        "18:10 – 18:35", "18:40 – 19:05", "19:10 – 19:35",
      ]);
      for (const window of match.windows) {
        expect(Date.parse(window.endAt) - Date.parse(window.startAt)).toBeGreaterThanOrEqual(25 * 60_000);
        expect(window.remaining).toBeNull();
      }
      const service = await import("../src/services/vip/vip.service");
      await expect(service.getPublicSalesStatus()).resolves.toMatchObject({
        preordersEnabled: true,
        preordersOpen: true,
      });
    });

    it("schedules a preorder against its window even while live sales are paused", async () => {
      mockRows.set(`vip_service_configs/${today}`, {
        ...mockRows.get("vip_service_configs/2026-08-26"),
        acceptingOrders: false,
      });
      mockRows.set("inventarios/inv-1", {
        ...mockRows.get("inventarios/inv-1"),
        activo: true,
        jornada_fecha: today,
      });
      const service = await import("../src/services/vip/vip.service");
      await expect(service.createCheckout(checkoutInput(), "checkout-live-paused"))
        .rejects.toMatchObject({ code: "VIP_SERVICE_PAUSED" });

      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-001");
      const order = mockRows.get(`vip_orders/${checkout.orderId}`);
      expect(order).toMatchObject({
        orderType: "PREORDER",
        fecha: matchDate,
        matchId: "jornada-1",
        status: "PENDING_PAYMENT",
        preorder: { windowStart: "18:10", windowEnd: "18:35", jornadaNumero: 11, slotId: "jornada-1__Poniente__1810" },
      });
      expect(order?.orderNumber).toMatch(/^PREV-\d{8}-/);
      expect(order?.scheduledFor?.toMillis()).toBe(order?.preorder.windowStartAt.toMillis());
      expect(order?.guideCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(mockRows.get(`vip_order_guides/${order?.guideCode}`)).toMatchObject({ orderId: checkout.orderId });
      expect(mockRows.get(slotPath("1810"))?.count).toBe(1);
      expect(mockRows.get(`vip_service_configs/${today}`)?.activeOrderCount).toBe(0);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(3);
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ orderType: "PREORDER", matchId: "jornada-1" }),
          line_items: [expect.objectContaining({
            price_data: expect.objectContaining({
              unit_amount: 26450,
              product_data: expect.objectContaining({ name: expect.stringContaining("Preventa") }),
            }),
          })],
        }),
        expect.anything(),
      );
    });

    it("pays straight into the scheduled state, tracks by guide and frees the window on refund", async () => {
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput("18:40"), "checkout-preorder-paid");
      await confirmPaid(service, checkout.orderId, "evt_paid_preorder");
      const orderPath = `vip_orders/${checkout.orderId}`;
      expect(mockRows.get(orderPath)?.status).toBe("ACCEPTED");
      expect(mockRows.get(orderPath)?.timestamps.acceptedAt).toBeDefined();
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toMatchObject({
        vipOrderType: "PREORDER",
        vipMatchId: "jornada-1",
      });
      expect(sendVipOrderPaidEmail).toHaveBeenCalledTimes(1);

      const guide = String(mockRows.get(orderPath)?.guideCode);
      const tracked = await service.lookupOrderByGuide(`${guide.slice(0, 4).toLowerCase()}-${guide.slice(4)}`);
      expect(tracked).toMatchObject({
        orderType: "PREORDER",
        status: "ACCEPTED",
        paymentStatus: "PAID",
        guideCode: `${guide.slice(0, 4)}-${guide.slice(4)}`,
        customer: { name: "Cliente" },
        preorder: { windowLabel: "18:40 – 19:05" },
      });
      expect(JSON.stringify(tracked)).not.toContain("cliente@example.com");
      expect(JSON.stringify(tracked)).not.toContain("4771234567");
      await expect(service.lookupOrderByGuide("ZZZZ-ZZZZ")).rejects.toMatchObject({ code: "VIP_ORDER_NOT_FOUND" });
      await expect(service.lookupOrderByGuide("abc")).rejects.toMatchObject({ code: "VIP_INVALID_GUIDE" });

      const preparing = await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      expect(preparing.status).toBe(VipOrderStatus.PREPARING);
      expect(mockRows.get(slotPath("1840"))?.count).toBe(1);
      const onTheWay = await service.transitionOrder(checkout.orderId, VipOrderStatus.ON_THE_WAY, actor);
      expect(onTheWay.status).toBe(VipOrderStatus.ON_THE_WAY);
      const { sendVipPreorderOnTheWayEmail } = await import("../src/services/vip/vip-email.service");
      expect(sendVipPreorderOnTheWayEmail).toHaveBeenCalledTimes(1);
      expect(mockRows.get("vip_service_configs/2026-08-26")?.activeOrderCount).toBe(0);

      await service.cancelOrder(checkout.orderId, "Cliente ya no asistirá", actor);
      expect(mockRows.get(orderPath)?.payment.status).toBe("REFUNDED");
      expect(mockRows.get(slotPath("1840"))?.count).toBe(0);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
    });

    it("never auto-dispatches a paid preorder when Central sends ACCEPTED", async () => {
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-accept");
      await confirmPaid(service, checkout.orderId, "evt_paid_preorder_accept");
      const same = await service.transitionOrder(checkout.orderId, VipOrderStatus.ACCEPTED, actor);
      expect(same.status).toBe(VipOrderStatus.ACCEPTED);
    });

    it("allows orders without capacity limits even if the window already has many orders", async () => {
      mockRows.set(slotPath("1910"), { count: 100 });
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput("19:10"), "checkout-no-capacity-limit");
      expect(checkout.orderId).toBeTruthy();
      expect(mockRows.get(slotPath("1910"))?.count).toBe(101);
    });

    it.each([
      ["a misaligned window", () => undefined, "19:00", "VIP_PREORDER_WINDOW_INVALID"],
      ["disabled preorders", () => mockRows.set("vip_preorder_configs/default", { enabled: false }), "18:10", "VIP_PREORDER_CLOSED"],
      ["a disabled match", () => mockRows.set("vip_preorder_configs/jornada-1", { enabled: false }), "18:10", "VIP_PREORDER_MATCH_UNAVAILABLE"],
      ["an inactive match", () => mockGetJornadaActiva.mockImplementation(async () => ({})), "18:10", "VIP_PREORDER_MATCH_UNAVAILABLE"],
      ["a closed service for the match date", () => mockRows.set(`vip_service_configs/${matchDate}`, { enabled: false }), "18:10", "VIP_SERVICE_CLOSED"],
    ])("rejects %s before reserving stock or calling Stripe", async (_name, mutate, windowStart, code) => {
      mutate();
      const service = await import("../src/services/vip/vip.service");
      await expect(service.createCheckout(preorderInput(windowStart), `checkout-${code}-${windowStart}`))
        .rejects.toMatchObject({ code });
      expect(mockSessionCreate).not.toHaveBeenCalled();
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(5);
    });

    it("rejects windows that start inside the minimum lead time", async () => {
      mockGetJornadaActiva.mockImplementation(async () => ({
        "varonil:Jornada11": {
          activo: true, rama: "varonil", jornada: 11, fecha: today, hora: "00:30",
        },
      }));
      mockRows.set("vip_preorder_configs/jornada-1", { windowStart: "00:00", windowEnd: "23:59" });
      const { getPreorderAvailability } = await import("../src/services/vip/vip-preorder.service");
      const availability = await getPreorderAvailability("Poniente");
      const minStart = Date.now() + 45 * 60_000;
      for (const window of availability.matches[0]?.windows || []) {
        expect(Date.parse(window.startAt)).toBeGreaterThanOrEqual(minStart - 1000);
      }
    });

    it("lists only paid preorders of the Central zone, ordered by delivery window", async () => {
      const service = await import("../src/services/vip/vip.service");
      const late = await service.createCheckout(preorderInput("19:10"), "checkout-board-late");
      await confirmPaid(service, late.orderId, "evt_board_late");
      const early = await service.createCheckout(preorderInput("18:10"), "checkout-board-early");
      await confirmPaid(service, early.orderId, "evt_board_early");
      mockRows.get("inventarios/inv-1/productos/p1")!.cantidad_final = 10;
      const unpaid = await service.createCheckout(preorderInput("18:40"), "checkout-board-unpaid");
      mockRows.set("vip_service_configs/2026-08-26", {
        ...mockRows.get("vip_service_configs/2026-08-26"),
        opensAt: Timestamp.fromMillis(Date.now() - 60_000),
        closesAt: Timestamp.fromMillis(Date.now() + 60_000),
      });
      mockBusinessDate.mockImplementation(() => "2026-08-26");
      const immediate = await service.createCheckout(checkoutInput(), "checkout-board-immediate");
      await confirmPaid(service, immediate.orderId, "evt_board_immediate");
      mockBusinessDate.mockImplementation(() => today);

      const board = await service.listAdminPreorders({ zona: "Poniente" });
      expect(board.data.map((row) => row.id)).toEqual([early.orderId, late.orderId]);
      expect(board.data.some((row) => row.id === unpaid.orderId || row.id === immediate.orderId)).toBe(false);
      await expect(service.listAdminPreorders({ zona: "Oriente" })).resolves.toMatchObject({ data: [] });
    });

    it("toggles preorders only with the Central password", async () => {
      process.env.VIP_CENTRAL_ZONE_PASSWORD = "Palcos.2026";
      const service = await import("../src/services/vip/vip.service");
      await expect(service.setAdminPreorderSettings("wrong", false, "admin-1"))
        .rejects.toMatchObject({ code: "VIP_INVALID_ZONE_PASSWORD" });
      const closed = await service.setAdminPreorderSettings("Palcos.2026", false, "admin-1");
      expect(closed.enabled).toBe(false);
      expect(mockRows.get("vip_preorder_configs/default")).toMatchObject({ enabled: false, updatedBy: "admin-1" });
      await expect(service.getPublicSalesStatus()).resolves.toMatchObject({
        preordersEnabled: false,
        preordersOpen: false,
      });
    });

    it("keeps a preorder without stock off any other open inventory until that match is loaded", async () => {
      mockRows.set("inventarios/inv-1/productos/p1", {
        cantidad_inicial: 0,
        cantidad_final: 0,
        precio_jornada: 100,
      });
      mockRows.set("sucursales/s-other", { activo: true, concesion_id: "c1" });
      mockRows.set("inventarios/inv-other", {
        activo: true,
        sucursal_id: "s-other",
        rama: "varonil",
        jornada_fecha: today,
        jornada_numero: 1,
      });
      mockRows.set("inventarios/inv-other/productos/p1", {
        cantidad_inicial: 0,
        cantidad_final: 0,
        precio_jornada: 100,
      });
      const service = await import("../src/services/vip/vip.service");
      await expect(service.createCheckout(checkoutInput(), "checkout-live-without-stock"))
        .rejects.toMatchObject({ code: "VIP_OUT_OF_STOCK" });

      mockRows.set("inventarios/inv-other/productos/p1", {
        cantidad_inicial: 20,
        cantidad_final: 20,
        precio_jornada: 100,
      });
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-deferred");
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
      expect(mockRows.get("inventarios/inv-other/productos/p1")?.cantidad_final).toBe(20);
      const reservation = [...mockRows.entries()].find(([path, row]) =>
        path.startsWith("vip_reservations/") && row.orderId === checkout.orderId,
      )?.[1];
      expect(reservation).toMatchObject({
        inventoryDeferred: true,
        inventoryApplied: false,
        inventoryId: "inv-1",
        status: "ACTIVE",
      });

      await service.cancelOrder(checkout.orderId, "El cliente cerró el pago", actor);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
      expect(mockRows.get("inventarios/inv-other/productos/p1")?.cantidad_final).toBe(20);
      expect(mockRows.get(slotPath("1810"))?.count).toBe(0);
    });

    it("prices a deferred preorder from the catalog when the match has no product line", async () => {
      mockRows.delete("inventarios/inv-1/productos/p1");
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-missing-line");
      const order = mockRows.get(`vip_orders/${checkout.orderId}`);
      expect(order?.items[0]).toMatchObject({ productId: "p1", unitPrice: 1014 });
      const reservation = [...mockRows.entries()].find(([path, row]) =>
        path.startsWith("vip_reservations/") && row.orderId === checkout.orderId,
      )?.[1];
      expect(reservation).toMatchObject({
        inventoryDeferred: true,
        inventoryApplied: false,
        inventoryId: "inv-1",
      });
      expect(checkout.checkoutUrl).toEqual(expect.any(String));
    });

    it("posts a paid preorder into that match inventory once stock is loaded, and restores it on refund", async () => {
      mockRows.set("inventarios/inv-1/productos/p1", {
        cantidad_inicial: 0,
        cantidad_final: 0,
        precio_jornada: 100,
      });
      mockRows.set("sucursales/s-other", { activo: true, concesion_id: "c1" });
      mockRows.set("inventarios/inv-other", {
        activo: true,
        sucursal_id: "s-other",
        rama: "varonil",
        jornada_fecha: today,
        jornada_numero: 9,
      });
      mockRows.set("inventarios/inv-other/productos/p1", {
        cantidad_inicial: 20,
        cantidad_final: 20,
        precio_jornada: 50,
      });
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput("18:40"), "checkout-preorder-settle");
      await confirmPaid(service, checkout.orderId, "evt_preorder_deferred_paid");
      const orderPath = `vip_orders/${checkout.orderId}`;
      expect(mockRows.get(orderPath)?.status).toBe("ACCEPTED");
      expect(mockRows.get(orderPath)?.salesRecorded).toBe(false);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toBeUndefined();
      expect(mockRows.get("inventarios/inv-other/productos/p1")?.cantidad_final).toBe(20);

      const { applyDeferredVipInventory } = await import("../src/services/vip/vip-preorder-inventory.service");
      await applyDeferredVipInventory("inv-1");
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toBeUndefined();

      mockRows.set("inventarios/inv-1/productos/p1", {
        ...mockRows.get("inventarios/inv-1/productos/p1"),
        cantidad_inicial: 10,
        cantidad_final: 10,
        precio_jornada: 100,
      });
      await applyDeferredVipInventory("inv-1");
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(8);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toMatchObject({
        vipOrderType: "PREORDER",
        inventarioId: "inv-1",
        jornadaId: "jornada-1",
      });
      expect(mockRows.get("inventarios/inv-other/productos/p1")?.cantidad_final).toBe(20);
      const ventaMoves = () => [...mockRows.entries()].filter(([path, row]) =>
        path.startsWith("inventarios/inv-1/movimientos/") && row.tipo === "VENTA" && row.vipOrderId === checkout.orderId,
      );
      expect(ventaMoves()).toHaveLength(1);

      await applyDeferredVipInventory("inv-1");
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(8);
      expect(ventaMoves()).toHaveLength(1);
      expect([...mockRows.keys()].filter((path) =>
        path.startsWith(`comprobantes_venta/vip_${checkout.orderId}`) && !path.includes("/detalle/"),
      )).toHaveLength(1);

      await service.cancelOrder(checkout.orderId, "El palco canceló", actor);
      expect(mockRows.get(orderPath)?.payment.status).toBe("REFUNDED");
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(10);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)?.status).toBe("REFUNDED");
    });

    it("applies a paid preorder on match day even when the loaded stock is still zero", async () => {
      mockRows.set("inventarios/inv-1/productos/p1", {
        cantidad_inicial: 0,
        cantidad_final: 0,
        precio_jornada: 100,
      });
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-matchday");
      await confirmPaid(service, checkout.orderId, "evt_preorder_matchday");
      mockBusinessDate.mockImplementation(() => matchDate);
      const { applyDeferredVipInventory } = await import("../src/services/vip/vip-preorder-inventory.service");
      await applyDeferredVipInventory("inv-1");
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(-2);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toMatchObject({
        inventarioId: "inv-1",
        vipOrderType: "PREORDER",
      });
      const preparing = await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      expect(preparing.status).toBe(VipOrderStatus.PREPARING);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(-2);
      expect([...mockRows.entries()].filter(([path, row]) =>
        path.startsWith("inventarios/inv-1/movimientos/") && row.tipo === "VENTA" && row.vipOrderId === checkout.orderId,
      )).toHaveLength(1);

      mockRows.set("inventarios/inv-1", { ...mockRows.get("inventarios/inv-1"), activo: false });
      await service.cancelOrder(checkout.orderId, "Inventario ya cerrado", actor);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(-2);
    });

    it("keeps a paid preorder when the match inventory header does not exist yet", async () => {
      mockRows.delete("inventarios/inv-1");
      mockRows.delete("inventarios/inv-1/productos/p1");
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-missing-header");
      const created = mockRows.get(`vip_orders/${checkout.orderId}`);
      const payload = JSON.stringify({
        id: "evt_preorder_missing_header",
        object: "event",
        api_version: "2025-02-24.acacia",
        created: 1,
        data: {
          object: {
            id: "pi_preorder_missing_header",
            object: "payment_intent",
            amount_received: created?.totalMinor,
            currency: String(created?.currency || "mxn").toLowerCase(),
            metadata: { orderId: checkout.orderId, source: "VIP" },
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: null,
        type: "payment_intent.succeeded",
      });
      await service.processStripeWebhook(Buffer.from(payload), signEvent(payload));
      const order = mockRows.get(`vip_orders/${checkout.orderId}`);
      expect(order?.status).toBe("ACCEPTED");
      expect(order?.payment.status).toBe("PAID");
      expect(order?.timestamps?.cancelledAt ?? null).toBeNull();
      expect(mockRefundCreate).not.toHaveBeenCalled();
      const reservation = [...mockRows.entries()].find(([path, row]) =>
        path.startsWith("vip_reservations/") && row.orderId === checkout.orderId,
      )?.[1];
      expect(reservation).toMatchObject({
        status: "CONFIRMED",
        inventoryDeferred: true,
        inventoryApplied: false,
      });
    });

    it("records a deferred preorder once when preparation starts, even if the loaded stock is still zero", async () => {
      mockRows.set("inventarios/inv-1/productos/p1", {
        cantidad_inicial: 0,
        cantidad_final: 0,
        precio_jornada: 100,
      });
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-prepare");
      await confirmPaid(service, checkout.orderId, "evt_preorder_prepare");
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toBeUndefined();

      const preparing = await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      expect(preparing.status).toBe(VipOrderStatus.PREPARING);
      expect(preparing.salesRecorded).toBe(true);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(-2);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toMatchObject({
        vipOrderId: checkout.orderId,
        vipOrderType: "PREORDER",
        inventarioId: "inv-1",
      });
      const ventaMoves = () => [...mockRows.entries()].filter(([path, row]) =>
        path.includes("/movimientos/") && row.tipo === "VENTA" && row.vipOrderId === checkout.orderId,
      );
      expect(ventaMoves()).toHaveLength(1);

      const { applyDeferredVipInventory } = await import("../src/services/vip/vip-preorder-inventory.service");
      await applyDeferredVipInventory("inv-1");
      await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(-2);
      expect(ventaMoves()).toHaveLength(1);
      expect([...mockRows.keys()].filter((path) =>
        path.startsWith(`comprobantes_venta/vip_${checkout.orderId}`) && !path.includes("/detalle/"),
      )).toHaveLength(1);

      await service.cancelOrder(checkout.orderId, "El palco canceló", actor);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(0);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)?.status).toBe("REFUNDED");
    });

    it("lets preparation start without inventory and posts the sale once that match line exists", async () => {
      mockRows.delete("inventarios/inv-1/productos/p1");
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-prepare-later");
      const created = mockRows.get(`vip_orders/${checkout.orderId}`);
      const payload = JSON.stringify({
        id: "evt_preorder_prepare_later",
        object: "event",
        api_version: "2025-02-24.acacia",
        created: 1,
        data: {
          object: {
            id: "pi_preorder_prepare_later",
            object: "payment_intent",
            amount_received: created?.totalMinor,
            currency: String(created?.currency || "mxn").toLowerCase(),
            metadata: { orderId: checkout.orderId, source: "VIP" },
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: null,
        type: "payment_intent.succeeded",
      });
      await service.processStripeWebhook(Buffer.from(payload), signEvent(payload));

      const preparing = await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      expect(preparing.status).toBe(VipOrderStatus.PREPARING);
      expect(preparing.salesRecorded).toBe(false);
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toBeUndefined();

      mockRows.set("inventarios/inv-match", {
        activo: true,
        sucursal_id: "s1",
        concesion_id: "c1",
        rama: "varonil",
        jornada_fecha: matchDate,
        jornada_numero: 11,
      });
      mockRows.set("inventarios/inv-match/productos/p1", {
        cantidad_inicial: 10,
        cantidad_final: 10,
        precio_jornada: 100,
      });
      const again = await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      expect(again.status).toBe(VipOrderStatus.PREPARING);
      expect(mockRows.get("inventarios/inv-match/productos/p1")?.cantidad_final).toBe(8);
      expect(mockRows.get("inventarios/inv-1/productos/p1")).toBeUndefined();
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toMatchObject({
        inventarioId: "inv-match",
        vipOrderType: "PREORDER",
      });
      const reservation = [...mockRows.entries()].find(([path, row]) =>
        path.startsWith("vip_reservations/") && row.orderId === checkout.orderId,
      )?.[1];
      expect(reservation).toMatchObject({ inventoryApplied: true, inventoryId: "inv-match" });

      await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      const { applyDeferredVipInventory } = await import("../src/services/vip/vip-preorder-inventory.service");
      await applyDeferredVipInventory("inv-match");
      await applyDeferredVipInventory("inv-1");
      expect(mockRows.get("inventarios/inv-match/productos/p1")?.cantidad_final).toBe(8);
      expect([...mockRows.entries()].filter(([path, row]) =>
        row.tipo === "VENTA" && row.vipOrderId === checkout.orderId,
      )).toHaveLength(1);
      expect([...mockRows.keys()].filter((path) =>
        path.startsWith(`comprobantes_venta/vip_${checkout.orderId}`) && !path.includes("/detalle/"),
      )).toHaveLength(1);
    });

    it("posts the sale once when the match inventory line is saved after the preorder", async () => {
      mockRows.set("inventarios/inv-1", {
        ...mockRows.get("inventarios/inv-1"),
        activo: true,
        concesion_id: "c1",
        sucursal_id: "s1",
        jornada_fecha: matchDate,
      });
      mockRows.delete("inventarios/inv-1/productos/p1");
      const service = await import("../src/services/vip/vip.service");
      const checkout = await service.createCheckout(preorderInput(), "checkout-preorder-on-save");
      const created = mockRows.get(`vip_orders/${checkout.orderId}`);
      const payload = JSON.stringify({
        id: "evt_preorder_on_save",
        object: "event",
        api_version: "2025-02-24.acacia",
        created: 1,
        data: {
          object: {
            id: "pi_preorder_on_save",
            object: "payment_intent",
            amount_received: created?.totalMinor,
            currency: String(created?.currency || "mxn").toLowerCase(),
            metadata: { orderId: checkout.orderId, source: "VIP" },
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: null,
        type: "payment_intent.succeeded",
      });
      await service.processStripeWebhook(Buffer.from(payload), signEvent(payload));
      expect(mockRows.get(`comprobantes_venta/vip_${checkout.orderId}_c1`)).toBeUndefined();

      mockRows.set("inventarios/inv-1/productos/p1", {
        cantidad_inicial: 0,
        cantidad_final: 0,
        precio_jornada: 100,
      });
      const { settleInventoryQuietly } = await import("../src/services/vip/vip-preorder-inventory.service");
      await settleInventoryQuietly("inv-1");
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(-2);
      expect(mockRows.get(`vip_orders/${checkout.orderId}`)?.salesRecorded).toBe(true);
      await settleInventoryQuietly("inv-1");
      await service.transitionOrder(checkout.orderId, VipOrderStatus.PREPARING, actor);
      expect(mockRows.get("inventarios/inv-1/productos/p1")?.cantidad_final).toBe(-2);
      expect([...mockRows.entries()].filter(([, row]) => row.tipo === "VENTA" && row.vipOrderId === checkout.orderId)).toHaveLength(1);
      expect([...mockRows.keys()].filter((path) =>
        path.startsWith(`comprobantes_venta/vip_${checkout.orderId}`) && !path.includes("/detalle/"),
      )).toHaveLength(1);
    });
  });
});
