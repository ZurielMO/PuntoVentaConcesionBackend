import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as detalleVentaService from "../../services/detalle-venta.service";

export const createDetalleVenta = asyncHandler(
  async (req: Request, res: Response) => {
    const { ventaId, concesionId, sucursalId, inventarioId } = req.params;
    const data = await detalleVentaService.createDetalleVenta({
      ventaId,
      concesionId,
      sucursalId,
      inventarioId,
      productos: req.body.productos,
    });
    res.status(201).json({ success: true, data, message: "Comprobante creado" });
  },
);

export const updateDetalleVenta = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await detalleVentaService.updateDetalleVenta(
      req.params.id,
      req.body.productos,
    );
    res.status(200).json({ success: true, data });
  },
);
