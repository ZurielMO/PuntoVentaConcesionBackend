import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as sucursalService from "../../services/sucursal.service";

export const createSucursal = asyncHandler(
  async (req: Request, res: Response) => {
    const concesionId =
      (req.query.concesion_id as string | undefined) ||
      (req.body?.concesionId as string | undefined) ||
      (req.body?.concesion_id as string | undefined) ||
      (req.user?.concesionId as string | undefined);
    const zonaId = req.query.zona_id as string | undefined;
    if (!concesionId || !zonaId) {
      throw new ApiError(
        400,
        "Se requieren los query params concesion_id y zona_id",
        true,
        "MISSING_QUERY",
      );
    }
    const data = await sucursalService.createSucursal(
      concesionId,
      zonaId,
      req.body,
    );
    res.status(201).json({ success: true, data, message: "Sucursal creada" });
  },
);

export const updateSucursal = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await sucursalService.updateSucursal(req.params.id, req.body);
    res
      .status(200)
      .json({ success: true, data, message: "Sucursal actualizada" });
  },
);

export const deleteSucursal = asyncHandler(
  async (req: Request, res: Response) => {
    await sucursalService.softDeleteSucursal(req.params.id);
    res.status(204).send();
  },
);

export const createCaja = asyncHandler(async (req: Request, res: Response) => {
  const data = await sucursalService.createCaja(req.params.id, req.body);
  res.status(201).json({ success: true, data, message: "Caja creada" });
});

export const updateCaja = asyncHandler(async (req: Request, res: Response) => {
  const data = await sucursalService.updateCaja(
    req.params.id,
    req.params.cajaId,
    req.body,
  );
  res.status(200).json({ success: true, data, message: "Caja actualizada" });
});

export const deleteCaja = asyncHandler(async (req: Request, res: Response) => {
  await sucursalService.softDeleteCaja(req.params.id, req.params.cajaId);
  res.status(204).send();
});
