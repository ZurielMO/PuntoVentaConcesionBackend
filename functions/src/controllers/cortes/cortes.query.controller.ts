import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as corteService from "../../services/corte.service";
import * as corteReporteService from "../../services/corte-reporte.service";
import {
  getOperationalListFilters,
  getOperationalListFiltersAsync,
} from "../../utils/list-filters.util";
import {
  getUserConcessionId,
  isSuperAdmin,
} from "../../utils/roles.middlewares";

export const getCorteResumen = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = await getOperationalListFiltersAsync(req);
    const data = await corteService.buildCorteResumen({
      ...filters,
      // Permite emparejar cortes legacy sin cajaId al mismo cajero.
      idUser: filters.idUser ?? req.user?.uid,
    });
    res.status(200).json({ success: true, data });
  },
);

export const getReporteCortes = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) {
      throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
    }

    const operational = getOperationalListFilters(req);
    let concesionId =
      (req.query.concesionId as string | undefined) ?? operational.concesionId;

    if (!isSuperAdmin(user)) {
      const userConcesionId = getUserConcessionId(user);
      if (!userConcesionId) {
        throw new ApiError(403, "Usuario sin concesión", true, "FORBIDDEN");
      }
      if (concesionId && concesionId !== userConcesionId) {
        throw new ApiError(403, "No tienes acceso a esta concesión", true, "FORBIDDEN");
      }
      concesionId = userConcesionId;
    }

    const fecha = req.query.fecha as string | undefined;
    const jornadaRaw = req.query.jornada as string | undefined;
    const jornadaId = req.query.jornadaId as string | undefined;
    const jornadaNumero =
      jornadaRaw != null && jornadaRaw !== ""
        ? Number(jornadaRaw)
        : undefined;

    const data = await corteReporteService.buildReporteCortes({
      concesionId: concesionId || undefined,
      sucursalId: operational.sucursalId,
      jornadaId: jornadaId || undefined,
      fecha,
      jornadaNumero:
        jornadaNumero != null && !Number.isNaN(jornadaNumero)
          ? jornadaNumero
          : undefined,
    });

    res.status(200).json({ success: true, data });
  },
);

export const getCortes = asyncHandler(async (req: Request, res: Response) => {
  const filters = getOperationalListFilters(req);
  const jornadaId = req.query.jornadaId as string | undefined;
  const data = await corteService.listCortes({
    ...filters,
    jornadaId: jornadaId || undefined,
  });
  res.status(200).json({ success: true, data, count: data.length });
});

export const getCorteById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await corteService.getCorteById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
