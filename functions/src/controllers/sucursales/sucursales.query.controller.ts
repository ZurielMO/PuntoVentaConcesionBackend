import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as sucursalService from "../../services/sucursal.service";
import { UserRole } from "../../models";

const getEffectiveConcesionId = (req: Request): string | undefined => {
  const user = req.user;
  const rol = typeof user?.rol === "string" ? user.rol.toUpperCase() : undefined;
  const isSuperAdmin = rol === UserRole.SUPERADMIN || user?.admin === true || user?.isAdmin === true;
  return isSuperAdmin ? undefined : (user?.concesionId as string | undefined);
};

export const getSucursales = asyncHandler(async (req: Request, res: Response) => {
  const data = await sucursalService.listSucursales(getEffectiveConcesionId(req));
  res.status(200).json({ success: true, data, count: data.length });
});

export const getSucursalById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await sucursalService.getSucursalById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);

export const getCajas = asyncHandler(async (req: Request, res: Response) => {
  const data = await sucursalService.getCajas(req.params.id);
  res.status(200).json({ success: true, data, count: data.length });
});