import { Router } from "express";
import * as vipCtrl from "../controllers/vip/vip.controller";
import { validateBody, validateQuery } from "../middleware/validation.middleware";
import {
  vipAdminListSchema,
  vipAbandonCheckoutSchema,
  vipCancelSchema,
  vipCentralZoneUnlockSchema,
  vipCheckoutSchema,
  vipConfirmSessionSchema,
  vipRunnerSchema,
  vipStatusSchema,
  vipTrackingQuerySchema,
} from "../middleware/validators/vip.validator";
import { vipRateLimit } from "../middleware/vip-rate-limit.middleware";
import { authMiddleware } from "../utils/middlewares";
import { requireAdminOrSuperAdmin } from "../utils/roles.middlewares";

const router = Router();

router.post("/webhooks/stripe", vipCtrl.stripeWebhook);
router.get("/concessions", vipCtrl.getVipCatalog);
router.get("/concessions/:id", vipCtrl.getVipConcessionById);
router.get("/locations", vipCtrl.getVipLocations);
router.post(
  "/checkout",
  validateBody(vipCheckoutSchema, "VIP_INVALID_REQUEST"),
  vipRateLimit("checkout", 10, 60_000),
  vipCtrl.checkout,
);
router.post(
  "/checkout/confirm",
  validateBody(vipConfirmSessionSchema, "VIP_INVALID_REQUEST"),
  vipRateLimit("checkout_confirm", 20, 60_000, (req) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    return sessionId ? `session:${sessionId}` : undefined;
  }),
  vipCtrl.confirmCheckout,
);
router.post(
  "/checkout/abandon",
  validateBody(vipAbandonCheckoutSchema, "VIP_INVALID_REQUEST"),
  vipRateLimit("checkout_abandon", 20, 60_000, (req) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    const orderId = typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";
    return sessionId ? `session:${sessionId}` : orderId ? `order:${orderId}` : undefined;
  }),
  vipCtrl.abandonCheckout,
);
router.get(
  "/orders/:id/tracking",
  validateQuery(vipTrackingQuerySchema, "VIP_INVALID_TRACKING_TOKEN"),
  vipRateLimit("tracking", 60, 60_000),
  vipCtrl.tracking,
);
router.post("/orders", vipCtrl.legacyCreateOrder);

router.use("/admin", authMiddleware, requireAdminOrSuperAdmin);
router.post(
  "/admin/central-zone/unlock",
  validateBody(vipCentralZoneUnlockSchema, "VIP_INVALID_REQUEST"),
  vipCtrl.unlockCentralZone,
);
router.get("/admin/orders", validateQuery(vipAdminListSchema, "VIP_INVALID_FILTERS"), vipCtrl.listAdminOrders);
router.get("/admin/orders/:id", vipCtrl.getAdminOrder);
router.patch("/admin/orders/:id/status", validateBody(vipStatusSchema, "VIP_INVALID_REQUEST"), vipCtrl.updateStatus);
router.patch("/admin/orders/:id/runner", validateBody(vipRunnerSchema, "VIP_INVALID_REQUEST"), vipCtrl.updateRunner);
router.post("/admin/orders/:id/cancel", validateBody(vipCancelSchema, "VIP_INVALID_REQUEST"), vipCtrl.cancel);
router.post("/admin/orders/:id/refund", validateBody(vipCancelSchema, "VIP_INVALID_REQUEST"), vipCtrl.refund);
router.get("/admin/orders/:id/print-data", vipCtrl.printData);

export default router;
