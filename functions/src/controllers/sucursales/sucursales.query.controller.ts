import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as sucursalService from "../../services/sucursal.service";

export const getSucursales = asyncHandler(
  async (_req: Request, res: Response) => {
    const data = await sucursalService.listSucursales();
    res.status(200).json({ success: true, data, count: data.length });
  },
);

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
