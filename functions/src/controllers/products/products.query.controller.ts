import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as productService from "../../services/product.service";
import { UserRole } from "../../models";
import { isAdmin, isAdminCerveceria, isSuperAdmin } from "../../utils/roles.middlewares";

const canIncludeInactive = (req: Request): boolean =>
  (isSuperAdmin(req.user) || isAdmin(req.user) || isAdminCerveceria(req.user)) &&
  String(req.query.includeInactive).toLowerCase() === "true";

export const getProductsByConcession = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await productService.listProductsByConcession(
      req.params.concesionId,
      canIncludeInactive(req),
    );
    res.status(200).json({ success: true, data, count: data.length });
  },
);

const getEffectiveConcesionId = (req: Request): string | undefined => {
  const user = req.user;
  const rol = typeof user?.rol === "string" ? user.rol.toUpperCase() : undefined;
  const isSuperAdminRole =
    rol === UserRole.SUPERADMIN || user?.admin === true || user?.isAdmin === true;
  return isSuperAdminRole ? undefined : (user?.concesionId as string | undefined);
};

export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  const data = await productService.listProducts(
    getEffectiveConcesionId(req),
    canIncludeInactive(req),
  );
  res.status(200).json({ success: true, data, count: data.length });
});

export const getProductById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await productService.getProductById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
