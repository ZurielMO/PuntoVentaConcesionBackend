import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as inventarioService from "../../services/inventario.service";

const wantsProductos = (req: Request): boolean =>
  String(req.query.includeProductos).toLowerCase() === "true";

export const getInventarios = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await inventarioService.listInventarios(wantsProductos(req));
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const getInventarioById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await inventarioService.getInventarioById(
      req.params.id,
      wantsProductos(req),
    );
    res.status(200).json({ success: true, data });
  },
);

export const getInventarioProductos = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await inventarioService.listInventarioProductos(req.params.id);
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const getInventarioProducto = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await inventarioService.getInventarioProducto(
      req.params.id,
      req.params.productoId,
    );
    res.status(200).json({ success: true, data });
  },
);
