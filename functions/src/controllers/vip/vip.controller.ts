import { Request, Response } from "express";
import { ApiError } from "../../utils/api-error";
import { asyncHandler } from "../../utils/error-handler";
import {
  getUserConcessionId,
  getUserSucursalId,
  isAdminCerveceria,
  isSuperAdmin,
} from "../../utils/roles.middlewares";
import * as vipService from "../../services/vip/vip.service";

const actorFrom = (req: Request) => ({
  actorId: req.user?.uid || null,
  actorRole: String(req.user?.rol || "SYSTEM"),
});

const assertOrderAccess = (
  req: Request,
  order: Awaited<ReturnType<typeof vipService.getAdminOrder>>,
) => {
  if (isSuperAdmin(req.user)) return;
  const concessionId = getUserConcessionId(req.user);
  if (!concessionId || !order.concessionIds.includes(concessionId)) {
    throw new ApiError(403, "No tienes acceso a esta orden.", true, "VIP_UNAUTHORIZED");
  }
  if (isAdminCerveceria(req.user)) {
    const sucursalId = getUserSucursalId(req.user);
    if (!sucursalId || !order.sucursalIds?.includes(sucursalId)) {
      throw new ApiError(403, "No tienes acceso a esta sucursal.", true, "VIP_UNAUTHORIZED");
    }
  }
};

const assertOrderMutationAccess = (
  req: Request,
  order: Awaited<ReturnType<typeof vipService.getAdminOrder>>,
) => {
  assertOrderAccess(req, order);
  if (!isSuperAdmin(req.user) && order.concessionIds.length > 1) {
    throw new ApiError(
      403,
      "Las órdenes con varias concesiones requieren operación central SUPERADMIN.",
      true,
      "VIP_UNAUTHORIZED",
    );
  }
};

export const getVipCatalog = asyncHandler(async (_req: Request, res: Response) => {
  const data = await vipService.listCatalog();
  res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
  res.status(200).json({ success: true, data, count: data.length });
});

export const getVipConcessionById = asyncHandler(async (req: Request, res: Response) => {
  const data = await vipService.getCatalogConcession(req.params.id);
  res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
  res.status(200).json({ success: true, data });
});

export const getVipLocations = asyncHandler(async (_req: Request, res: Response) => {
  const data = await vipService.listLocations();
  res.status(200).json({ success: true, data, count: data.length });
});

const originFromReferer = (referer?: string): string | undefined => {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
};

export const checkout = asyncHandler(async (req: Request, res: Response) => {
  const returnOrigin =
    req.header("x-forwarded-origin") ||
    req.header("origin") ||
    originFromReferer(req.header("referer"));
  const data = await vipService.createCheckout(
    req.body,
    req.header("Idempotency-Key") || "",
    returnOrigin,
  );
  res.status(201).json({ success: true, data, message: "Checkout de palcos iniciado" });
});

export const confirmCheckout = asyncHandler(async (req: Request, res: Response) => {
  const data = await vipService.confirmCheckoutSession(String(req.body.sessionId || ""));
  res.status(200).json({ success: true, data });
});

export const abandonCheckout = asyncHandler(async (req: Request, res: Response) => {
  const data = await vipService.abandonCheckout(req.body);
  res.status(200).json({ success: true, data });
});

export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.header("Stripe-Signature");
  if (!signature) {
    throw new ApiError(400, "Stripe-Signature es requerido.", true, "VIP_INVALID_WEBHOOK_SIGNATURE");
  }
  const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : req.rawBody;
  if (!rawBody?.length) {
    throw new ApiError(400, "El webhook requiere el body raw.", true, "VIP_INVALID_WEBHOOK_SIGNATURE");
  }
  const data = await vipService.processStripeWebhook(rawBody, signature);
  res.status(200).json({ success: true, data });
});

export const tracking = asyncHandler(async (req: Request, res: Response) => {
  const data = await vipService.getTracking(req.params.id, String(req.query.token));
  res.status(200).json({ success: true, data });
});

export const legacyCreateOrder = asyncHandler(async (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    code: "VIP_CHECKOUT_REQUIRED",
    message: "La creación directa de órdenes fue retirada. Usa POST /vip/checkout.",
  });
});

export const listAdminOrders = asyncHandler(async (req: Request, res: Response) => {
  const filters = { ...req.query } as unknown as Parameters<typeof vipService.listAdminOrders>[0];
  if (!isSuperAdmin(req.user)) {
    if (isAdminCerveceria(req.user)) {
      const sucursalId = getUserSucursalId(req.user);
      if (!sucursalId) {
        throw new ApiError(403, "Usuario sin sucursal asignada.", true, "VIP_UNAUTHORIZED");
      }
      filters.sucursalId = sucursalId;
      delete filters.concessionId;
    } else {
      const concessionId = getUserConcessionId(req.user);
      if (!concessionId) {
        throw new ApiError(403, "Usuario sin concesión asignada.", true, "VIP_UNAUTHORIZED");
      }
      filters.concessionId = concessionId;
      delete filters.sucursalId;
    }
  }
  const result = await vipService.listAdminOrders(filters);
  res.status(200).json({ success: true, ...result });
});

export const getAdminOrder = asyncHandler(async (req: Request, res: Response) => {
  const data = await vipService.getAdminOrder(req.params.id);
  assertOrderAccess(req, data);
  res.status(200).json({ success: true, data });
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const current = await vipService.getAdminOrder(req.params.id);
  assertOrderMutationAccess(req, current);
  const data = await vipService.transitionOrder(
    req.params.id,
    req.body.status,
    actorFrom(req),
    req.body.metadata,
  );
  res.status(200).json({ success: true, data });
});

export const updateRunner = asyncHandler(async (req: Request, res: Response) => {
  const current = await vipService.getAdminOrder(req.params.id);
  assertOrderMutationAccess(req, current);
  const data = await vipService.assignRunner(req.params.id, req.body, actorFrom(req));
  res.status(200).json({ success: true, data });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const current = await vipService.getAdminOrder(req.params.id);
  assertOrderMutationAccess(req, current);
  const data = await vipService.cancelOrder(req.params.id, req.body.reason, actorFrom(req));
  res.status(200).json({ success: true, data });
});

export const refund = asyncHandler(async (req: Request, res: Response) => {
  const current = await vipService.getAdminOrder(req.params.id);
  assertOrderMutationAccess(req, current);
  const data = await vipService.refundOrder(req.params.id, req.body.reason, actorFrom(req));
  res.status(200).json({ success: true, data });
});

export const printData = asyncHandler(async (req: Request, res: Response) => {
  const current = await vipService.getAdminOrder(req.params.id);
  assertOrderAccess(req, current);
  const data = await vipService.getPrintData(req.params.id, actorFrom(req));
  res.status(200).json({ success: true, data });
});

export const unlockCentralZone = asyncHandler(async (req: Request, res: Response) => {
  const data = vipService.unlockCentralZone(String(req.body.password || ""), req.body.zona);
  res.status(200).json({ success: true, data });
});
