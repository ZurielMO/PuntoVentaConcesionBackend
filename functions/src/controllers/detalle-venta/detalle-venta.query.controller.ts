import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as detalleVentaService from "../../services/detalle-venta.service";

export const getDetalleVentaById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await detalleVentaService.getDetalleVentaById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
