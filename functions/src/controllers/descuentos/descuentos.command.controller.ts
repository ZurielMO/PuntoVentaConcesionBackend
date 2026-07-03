import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as descuentoService from "../../services/descuento.service";

export const createDescuento = asyncHandler(
  async (req: Request, res: Response) => {
    const { concesionId, ...data } = req.body;
    const descuento = await descuentoService.createDescuento(concesionId, data, {
      uid: req.user?.uid ?? null,
      nombre: (req.user?.nombre as string | undefined) ?? null,
    });
    res
      .status(201)
      .json({ success: true, data: descuento, message: "Descuento creado" });
  },
);

export const updateDescuento = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await descuentoService.updateDescuento(req.params.id, req.body);
    res
      .status(200)
      .json({ success: true, data, message: "Descuento actualizado" });
  },
);

export const deleteDescuento = asyncHandler(
  async (req: Request, res: Response) => {
    await descuentoService.softDeleteDescuento(req.params.id);
    res.status(204).send();
  },
);

export const hardDeleteDescuento = asyncHandler(
  async (req: Request, res: Response) => {
    await descuentoService.hardDeleteDescuento(req.params.id);
    res.status(204).send();
  },
);
