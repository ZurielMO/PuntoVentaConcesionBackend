import Stripe from "stripe";

const create = jest.fn();
const get = jest.fn();
const set = jest.fn();
const doc = jest.fn(() => ({ create, get, set }));
const collection = jest.fn(() => ({ doc }));

jest.mock("../src/config/firebase", () => ({
  firestorePos: { collection },
}));

describe("VIP Stripe webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "unit_test_key_not_a_secret";
    process.env.STRIPE_WEBHOOK_SECRET = "unit_test_webhook_secret";
    process.env.VIP_TRACKING_SECRET = "test-secret-at-least-32-characters-long";
  });

  it("rejects an invalid signature before any Firestore access", async () => {
    const { processStripeWebhook } = await import("../src/services/vip/vip.service");
    await expect(processStripeWebhook(Buffer.from("{}"), "bad-signature"))
      .rejects.toMatchObject({ code: "VIP_INVALID_WEBHOOK_SIGNATURE" });
    expect(collection).not.toHaveBeenCalled();
  });

  it("acknowledges a previously processed Stripe event without replaying effects", async () => {
    create.mockRejectedValueOnce(new Error("ALREADY_EXISTS"));
    get.mockResolvedValueOnce({ exists: true, data: () => ({ status: "PROCESSED" }) });
    const payload = JSON.stringify({
      id: "evt_vip_duplicate",
      object: "event",
      api_version: "2025-02-24.acacia",
      created: 1,
      data: { object: { id: "cs_test", object: "checkout.session", metadata: { orderId: "order-1" } } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
    const { processStripeWebhook } = await import("../src/services/vip/vip.service");
    await expect(processStripeWebhook(Buffer.from(payload), signature)).resolves.toEqual({
      duplicate: true,
      eventId: "evt_vip_duplicate",
      eventType: "checkout.session.completed",
    });
    expect(set).not.toHaveBeenCalled();
  });

  it("does not accept a payment_intent.succeeded payload without a verified signature", async () => {
    const { processStripeWebhook } = await import("../src/services/vip/vip.service");
    const payload = JSON.stringify({
      id: "evt_paid_unsigned",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1", metadata: { orderId: "order-1" } } },
    });
    await expect(processStripeWebhook(Buffer.from(payload), "t=1,v1=deadbeef"))
      .rejects.toMatchObject({ code: "VIP_INVALID_WEBHOOK_SIGNATURE" });
    expect(collection).not.toHaveBeenCalled();
  });
});
