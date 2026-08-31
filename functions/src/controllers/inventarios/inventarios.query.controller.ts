import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as inventarioService from "../../services/inventario.service";
import {
  getSucursalConcessionId,
  getUserConcessionId,
  getUserSucursalId,
  isAdminCerveceria,
  isSuperAdmin,
  isVendedor,
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

/** Resuelve la sucursal objetivo validando que el rol tenga acceso a ella. */
const resolveSucursalId = async (req: Request): Promise<string> => {
  const user = req.user;
  const querySucursalId = req.query.sucursalId as string | undefined;

  if (isSuperAdmin(user)) {
    if (!querySucursalId) {
      throw new ApiError(400, "Se requiere sucursalId", true, "MISSING_SUCURSAL");
    }
    return querySucursalId;
  }

  if (isVendedor(user) || isAdminCerveceria(user)) {
    const sucursalId = getUserSucursalId(user);
    if (!sucursalId) {
      throw new ApiError(403, "Usuario sin sucursal asignada", true, "FORBIDDEN");
    }
    return sucursalId;
  }

  // ADMIN: puede consultar cualquier sucursal de su concesión
  if (!querySucursalId) {
    throw new ApiError(400, "Se requiere sucursalId", true, "MISSING_SUCURSAL");
  }
  const userConcessionId = getUserConcessionId(user);
  const sucursalConcesionId = await getSucursalConcessionId(querySucursalId);
  if (!userConcessionId || userConcessionId !== sucursalConcesionId) {
    throw new ApiError(403, "No tienes acceso a esta sucursal", true, "FORBIDDEN");
  }
  return querySucursalId;
};

export const getInventarios = asyncHandler(async (req: Request, res: Response) => {
  const data = await inventarioService.listInventarios(wantsProductos(req), {
    concesionId: getEffectiveConcesionId(req),
    sucursalId: req.query.sucursalId as string | undefined,
  });

  res.status(200).json({ success: true, data, count: data.length });
});

export const getInventarioJornadaActiva = asyncHandler(
  async (req: Request, res: Response) => {
    const sucursalId = await resolveSucursalId(req);
    const ramaRaw = req.query.rama as string | undefined;
    const rama =
      ramaRaw === "femenil" || ramaRaw === "varonil" ? ramaRaw : "varonil";

    const { inventario, jornada } = await inventarioService.getInventarioJornadaActiva(
      sucursalId,
      wantsProductos(req),
      rama,
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
