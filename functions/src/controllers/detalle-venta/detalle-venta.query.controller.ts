import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as detalleVentaService from "../../services/detalle-venta.service";
import { getOperationalListFiltersAsync } from "../../utils/list-filters.util";

export const getDetalleVentas = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = await getOperationalListFiltersAsync(req);
    const data = await detalleVentaService.listDetalleVentas(filters);
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const getDetalleVentaById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await detalleVentaService.getDetalleVentaById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
