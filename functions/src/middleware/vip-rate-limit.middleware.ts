import { createHash } from "crypto";
import { NextFunction, Request, Response } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { asyncHandler } from "../utils/error-handler";
import { ApiError } from "../utils/api-error";

export type VipRateLimitIdentity = (req: Request) => string | undefined | null;

export const vipRateLimit = (
  scope: string,
  maxRequests: number,
  windowMs: number,
  identityFrom?: VipRateLimitIdentity,
) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    // Local Next BFF shares one IP for every guest; rate-limiting that bucket
    // blocks legitimate Stripe confirm retries (React Strict Mode + reloads).
    if (process.env.IS_LOCAL === "true") {
      next();
      return;
    }
    // Cloud Run/GFE appends `client-ip, serverless-proxy-ip`. Selecting the
    // value immediately before the trusted platform hop avoids both grouping
    // every guest under the proxy IP and trusting a client-prepended value.
    const forwardedChain = req.header("x-forwarded-for")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) || [];
    const forwarded = forwardedChain.length >= 2
      ? forwardedChain[forwardedChain.length - 2]
      : forwardedChain[0];
    const scopedIdentity = identityFrom?.(req)?.trim();
    const identity = scopedIdentity || forwarded || req.ip || req.socket.remoteAddress || "unknown";
    const bucket = Math.floor(Date.now() / windowMs);
    const key = createHash("sha256").update(`${scope}:${identity}:${bucket}`).digest("hex");
    const ref = firestorePos.collection(COLLECTIONS.VIP_RATE_LIMITS).doc(key);

    await firestorePos.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = Number(snap.data()?.count || 0);
      if (count >= maxRequests) {
        throw new ApiError(429, "Demasiadas solicitudes. Intenta más tarde.", true, "VIP_RATE_LIMITED");
      }
      tx.set(ref, {
        scope,
        count: FieldValue.increment(1),
        expiresAt: Timestamp.fromMillis((bucket + 2) * windowMs),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    next();
  });
