import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as inventarioService from "../../services/inventario.service";

export const createInventario = asyncHandler(
  async (req: Request, res: Response) => {
    const { jornadaNumero, fechaJornada, sucursalId } = req.params;
    const data = await inventarioService.createInventario(
      jornadaNumero,
      fechaJornada,
      sucursalId,
    );
    res.status(201).json({ success: true, data, message: "Inventario creado" });
  },
);

export const deleteInventario = asyncHandler(
  async (req: Request, res: Response) => {
    await inventarioService.softDeleteInventario(req.params.id);
    res.status(204).send();
  },
);

export const upsertInventarioProducto = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await inventarioService.upsertInventarioProducto(
      req.params.id,
      req.params.productoId,
      req.body,
    );
    res.status(200).json({ success: true, data });
  },
);

export const deleteInventarioProducto = asyncHandler(
  async (req: Request, res: Response) => {
    await inventarioService.deleteInventarioProducto(
      req.params.id,
      req.params.productoId,
    );
    res.status(204).send();
  },
);
