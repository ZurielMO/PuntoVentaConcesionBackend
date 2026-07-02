import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as inventarioService from "../../services/inventario.service";
import {
  getUserConcessionId,
  isSuperAdmin,
} from "../../utils/roles.middlewares";

const wantsProductos = (req: Request): boolean =>
  String(req.query.includeProductos).toLowerCase() === "true";

const getEffectiveConcesionId = (req: Request): string | undefined => {
  const user = req.user;
  if (!user || isSuperAdmin(user)) {
    return req.query.concesionId as string | undefined;
  }
  return getUserConcessionId(user);
};

export const getInventarios = asyncHandler(async (req: Request, res: Response) => {
  const data = await inventarioService.listInventarios(
    wantsProductos(req),
    getEffectiveConcesionId(req),
  );

  res.status(200).json({ success: true, data, count: data.length });
});

export const getInventarioJornadaActiva = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;
    const concesionId = isSuperAdmin(user)
      ? (req.query.concesionId as string | undefined)
      : getUserConcessionId(user);

    if (!concesionId) {
      res.status(403).json({
        success: false,
        message: "Usuario sin concesión asignada",
      });
      return;
    }

    const { inventario, jornada } = await inventarioService.getInventarioJornadaActiva(
      concesionId,
      wantsProductos(req),
    );

    res.status(200).json({
      success: true,
      data: { inventario, jornada },
    });
  },
);

export const getInventarioMovimientos = asyncHandler(
  async (req: Request, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const data = await inventarioService.listMovimientos(req.params.id, limit);
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
