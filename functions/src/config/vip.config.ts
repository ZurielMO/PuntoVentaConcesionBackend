import { createHash, createHmac, timingSafeEqual } from "crypto";
import Stripe from "stripe";
import { ApiError } from "../utils/api-error";
import { getAllowedCorsOriginsWithStore } from "./cors.config";

const STRIPE_API_VERSION = "2025-02-24.acacia" as Stripe.LatestApiVersion;
let stripeClient: Stripe | null = null;

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ApiError(503, `Configuración VIP incompleta: ${name}`, true, "VIP_NOT_CONFIGURED");
  }
  return value;
};

const isLocalVipRuntime = (): boolean =>
  process.env.NODE_ENV !== "test" &&
  process.env.IS_LOCAL === "true" &&
  !process.env.K_SERVICE &&
  !process.env.FUNCTION_NAME;

const originFromUrl = (value?: string): string => {
  if (!value?.trim()) return "";
  try {
    return new URL(value.trim().replace("{CHECKOUT_SESSION_ID}", "session")).origin;
  } catch {
    return "";
  }
};

const isAllowedFrontendOrigin = (origin: string): boolean =>
  Boolean(origin) && getAllowedCorsOriginsWithStore().includes(origin);

export const resolveVipFrontendOrigin = (requestOrigin?: string): string => {
  const requested = originFromUrl(requestOrigin);
  if (requested && isAllowedFrontendOrigin(requested)) {
    return requested;
  }
  if (isLocalVipRuntime()) {
    return originFromUrl(process.env.VIP_PUBLIC_BASE_URL) || "http://localhost:9002";
  }
  const fromSuccess = originFromUrl(process.env.VIP_CHECKOUT_SUCCESS_URL);
  if (fromSuccess) return fromSuccess;
  throw new ApiError(503, "Configuración VIP incompleta: VIP_CHECKOUT_SUCCESS_URL", true, "VIP_NOT_CONFIGURED");
};

export const resolveVipReturnUrls = (requestOrigin?: string): { successUrl: string; cancelUrl: string } => {
  if (!isLocalVipRuntime()) {
    const requested = originFromUrl(requestOrigin);
    if (!requested) {
      return {
        successUrl: required("VIP_CHECKOUT_SUCCESS_URL"),
        cancelUrl: required("VIP_CHECKOUT_CANCEL_URL"),
      };
    }
  }
  const origin = resolveVipFrontendOrigin(requestOrigin);
  return {
    successUrl: `${origin}/servicio-palcos/pago/exito?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/servicio-palcos/pago/cancelado`,
  };
};

export const getVipCurrency = (): string =>
  (process.env.STRIPE_CURRENCY || "mxn").trim().toLowerCase();

/** Fecha operativa VIP en America/Mexico_City (YYYY-MM-DD). No usa jornada RTDB. */
export const getVipBusinessDate = (now = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
};

export const getVipReservationTtlMinutes = (): number => {
  const parsed = Number(process.env.VIP_RESERVATION_TTL_MINUTES || 30);
  return Number.isFinite(parsed) ? Math.max(30, Math.min(1440, parsed)) : 30;
};

export const getVipStripeClient = (): Stripe => {
  if (!stripeClient) {
    stripeClient = new Stripe(required("STRIPE_SECRET_KEY"), {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return stripeClient;
};

export const getVipStripeWebhookSecret = (): string =>
  required("STRIPE_WEBHOOK_SECRET");

export const getVipCentralZonePassword = (): string =>
  process.env.VIP_CENTRAL_ZONE_PASSWORD?.trim() || "Palcos.2026";

export const getVipSuccessUrl = (): string => resolveVipReturnUrls().successUrl;
export const getVipCancelUrl = (): string => resolveVipReturnUrls().cancelUrl;

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const buildTrackingToken = (orderId: string): string =>
  createHmac("sha256", required("VIP_TRACKING_SECRET"))
    .update(`vip-tracking:${orderId}`)
    .digest("base64url");

export const verifyTrackingToken = (orderId: string, candidate: string): boolean => {
  const expected = Buffer.from(buildTrackingToken(orderId));
  const received = Buffer.from(candidate.trim());
  return expected.length === received.length && timingSafeEqual(expected, received);
};

export const moneyToMinor = (value: number): number => Math.round(value * 100);
export const minorToMoney = (value: number): number => Number((value / 100).toFixed(2));
