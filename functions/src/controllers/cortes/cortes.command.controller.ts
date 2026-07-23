import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as corteService from "../../services/corte.service";
import { getOperationalListFiltersAsync } from "../../utils/list-filters.util";
import {
  getUserConcessionId,
  getUserSucursalId,
  isSuperAdmin,
} from "../../utils/roles.middlewares";

export const createCorte = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user;
  if (!user?.uid) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }

  const concesionId = getUserConcessionId(user);
  if (!concesionId) {
    throw new ApiError(403, "Usuario sin concesión asignada", true, "FORBIDDEN");
  }

  const ventaId = req.query.idventa as string | undefined;
  const data = await corteService.createCorte(
    {
      concesionId,
      sucursalId: getUserSucursalId(user) ?? null,
      idUser: user.uid,
      ventaId: ventaId ?? null,
    },
    req.body,
  );
  res.status(201).json({ success: true, data, message: "Corte creado" });
});

export const updateCorte = asyncHandler(async (req: Request, res: Response) => {
  const data = await corteService.updateCorte(req.params.id, req.body);
  res.status(200).json({ success: true, data, message: "Corte actualizado" });
});

export const cerrarCorte = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user;
  if (!user?.uid) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }

  const concesionId = getUserConcessionId(user);
  if (!concesionId) {
    throw new ApiError(403, "Usuario sin concesión asignada", true, "FORBIDDEN");
  }

  const filters = await getOperationalListFiltersAsync(req);
  const data = await corteService.cerrarCorte(
    {
      concesionId,
      sucursalId: getUserSucursalId(user) ?? null,
      idUser: user.uid,
    },
    {
      ...filters,
      idUser: user.uid,
    },
    req.body,
  );
  res.status(201).json({ success: true, data, message: "Corte cerrado" });
});

export const cerrarCortePorConteo = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;
    if (!user?.uid) {
      throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
    }

    const concesionId =
      getUserConcessionId(user) ??
      (isSuperAdmin(user)
        ? (req.query.concesionId as string | undefined)
        : undefined);
    if (!concesionId) {
      throw new ApiError(403, "Usuario sin concesión asignada", true, "FORBIDDEN");
    }

    // Admin cervecería/vendedor usan su sucursal; superadmin puede indicarla.
    const sucursalId =
      getUserSucursalId(user) ?? (req.query.sucursalId as string | undefined);
    if (!sucursalId) {
      throw new ApiError(400, "Se requiere sucursalId", true, "MISSING_SUCURSAL");
    }

    const data = await corteService.cerrarCortePorConteo(
      {
        concesionId,
        sucursalId,
        idUser: user.uid,
      },
      req.body,
    );
    res
      .status(201)
      .json({ success: true, data, message: "Corte cerrado por conteo" });
  },
);
