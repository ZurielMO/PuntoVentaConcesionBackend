/**
 * Variables mínimas para que los tests VIP no dependan de `.env.local`
 * (GitHub Actions no lo tiene).
 */
process.env.NODE_ENV = "test";
process.env.PROJECT_ID = process.env.PROJECT_ID || "demo-puntoventa-test";
process.env.VIP_TRACKING_SECRET =
  process.env.VIP_TRACKING_SECRET || "test-secret-at-least-32-characters-long";
process.env.STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "unit_test_key_not_a_secret";
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || "unit_test_webhook_secret";
process.env.VIP_CHECKOUT_SUCCESS_URL =
  process.env.VIP_CHECKOUT_SUCCESS_URL ||
  "https://example.com/success?session_id={CHECKOUT_SESSION_ID}";
process.env.VIP_CHECKOUT_CANCEL_URL =
  process.env.VIP_CHECKOUT_CANCEL_URL || "https://example.com/cancel";
