import axios from "axios";
import { Timestamp } from "firebase-admin/firestore";
import type { VipOrder } from "../src/models/vip.model";
import { VipOrderStatus, VipPaymentStatus } from "../src/models/vip.model";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const sampleOrder = (overrides: Partial<VipOrder> = {}): VipOrder => ({
  id: "order-1",
  orderNumber: "VIP-20260826-ABC123",
  fecha: "2026-08-26",
  jornadaId: "2026-08-26",
  matchId: "2026-08-26",
  customer: { name: "Ana Pérez", email: "ana@example.com", phone: "4771234567" },
  delivery: {
    locationId: null,
    zonaId: "zone-1",
    zona: "Poniente",
    palco: "12",
    nivel: "Nivel 2",
    notes: null,
  },
  items: [{
    id: "i1",
    productId: "p1",
    concessionId: "c1",
    inventoryId: "inv-1",
    sucursalId: "s1",
    name: "Hamburguesa",
    quantity: 2,
    unitPrice: 100,
    unitPriceMinor: 10000,
    selectedOptions: [{ id: "large", name: "Grande", price: 10, priceMinor: 1000 }],
    extras: [{ id: "cheese", name: "Queso", price: 5, priceMinor: 500 }],
    notes: "Sin cebolla",
    lineTotal: 230,
    lineTotalMinor: 23000,
  }],
  fulfillments: [],
  concessionIds: ["c1"],
  sucursalIds: ["s1"],
  subtotal: 230,
  subtotalMinor: 23000,
  serviceFee: 20,
  serviceFeeMinor: 2000,
  tip: 5,
  tipMinor: 500,
  total: 255,
  totalMinor: 25500,
  currency: "mxn",
  payment: {
    status: VipPaymentStatus.PAID,
    provider: "STRIPE",
    checkoutSessionId: "cs_1",
    paymentIntentId: "pi_1",
    refundId: null,
    amountMinor: 25500,
    currency: "mxn",
  },
  status: VipOrderStatus.RECEIVED,
  runner: null,
  runnerId: null,
  trackingTokenHash: "hash",
  reservationExpiresAt: Timestamp.now(),
  capacityReleased: false,
  inventoryConfirmed: true,
  salesRecorded: true,
  source: "VIP",
  channel: "VIP_DELIVERY",
  timestamps: {},
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  ...overrides,
});

describe("VIP Brevo emails", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      BREVO_API_KEY: "test-brevo-key",
      BREVO_SENDER_EMAIL: "no-reply@clubleon.com",
      BREVO_SENDER_NAME: "Club León",
      NODE_ENV: "test",
    };
    delete process.env.IS_LOCAL;
    mockedAxios.post.mockResolvedValue({ data: { messageId: "msg-1" } } as never);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("sends a paid confirmation with order number, palco and total", async () => {
    const { sendVipOrderPaidEmail } = await import("../src/services/vip/vip-email.service");
    await expect(sendVipOrderPaidEmail(sampleOrder())).resolves.toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [, payload, options] = mockedAxios.post.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "api-key": "test-brevo-key" }),
    }));
    expect(payload).toEqual(expect.objectContaining({
      sender: { email: "no-reply@clubleon.com", name: "Club León" },
      to: [{ email: "ana@example.com", name: "Ana Pérez" }],
      subject: "Pedido confirmado VIP-20260826-ABC123 - Servicio Palcos Club León",
    }));
    const html = String((payload as { htmlContent: string }).htmlContent);
    expect(html).toContain("VIP-20260826-ABC123");
    expect(html).toContain("Palco 12");
    expect(html).toContain("Poniente");
    expect(html).toContain("Hamburguesa");
    expect(html).toContain("Productos");
    expect(html).not.toContain("Cargo por servicio");
    expect(html).not.toContain("Propina");
    expect(html).toContain("$255.00 MXN");
  });

  it("sends a delivery confirmation mentioning the palco", async () => {
    const { sendVipOrderDeliveredEmail } = await import("../src/services/vip/vip-email.service");
    await expect(sendVipOrderDeliveredEmail(sampleOrder({
      status: VipOrderStatus.DELIVERED,
    }))).resolves.toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const payload = mockedAxios.post.mock.calls[0][1] as { subject: string; htmlContent: string };
    expect(payload.subject).toBe("Pedido entregado VIP-20260826-ABC123 - Servicio Palcos Club León");
    expect(payload.htmlContent).toContain("ya está en tu palco");
    expect(payload.htmlContent).toContain("12");
  });

  it("escapes HTML in customer and product names", async () => {
    const { sendVipOrderPaidEmail } = await import("../src/services/vip/vip-email.service");
    const order = sampleOrder({
      customer: { name: "<script>x</script>", email: "ana@example.com", phone: null },
      items: [{
        ...sampleOrder().items[0],
        name: "Taco <img>",
      }],
    });
    await sendVipOrderPaidEmail(order);
    const html = String((mockedAxios.post.mock.calls[0][1] as { htmlContent: string }).htmlContent);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("Taco &lt;img&gt;");
  });

  it("returns false without calling Brevo when the API key is missing", async () => {
    delete process.env.BREVO_API_KEY;
    process.env.IS_LOCAL = "true";
    const { sendVipOrderPaidEmail } = await import("../src/services/vip/vip-email.service");
    await expect(sendVipOrderPaidEmail(sampleOrder())).resolves.toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("returns false without calling Brevo when the order has no email", async () => {
    const { sendVipOrderPaidEmail } = await import("../src/services/vip/vip-email.service");
    await expect(sendVipOrderPaidEmail(sampleOrder({
      customer: { name: "Ana", email: "  ", phone: null },
    }))).resolves.toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("swallows Brevo HTTP errors and returns false", async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error("network down"));
    const { sendVipOrderPaidEmail } = await import("../src/services/vip/vip-email.service");
    await expect(sendVipOrderPaidEmail(sampleOrder())).resolves.toBe(false);
  });
});
