import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as jornadaService from "../../services/jornada.service";
import { getOperationalListFilters } from "../../utils/list-filters.util";
import {
  getUserConcessionId,
  isSuperAdmin,
} from "../../utils/roles.middlewares";

export const getJornadaActiva = asyncHandler(
  async (_req: Request, res: Response) => {
    const jornada_activa = await jornadaService.getJornadaActiva();
    const activas = await jornadaService.getJornadasActivasPorRama();
    res.status(200).json({ success: true, jornada_activa, activas });
  },
);

export const getJornadasDisponibles = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;
    const operational = getOperationalListFilters(req);
    let concesionId =
      (req.query.concesionId as string | undefined) ?? operational.concesionId;

    if (user && !isSuperAdmin(user)) {
      const userConcesionId = getUserConcessionId(user);
      if (userConcesionId) {
        concesionId = userConcesionId;
      }
    }

    const ramaRaw = req.query.rama as string | undefined;
    const rama =
      ramaRaw === "femenil" || ramaRaw === "varonil" ? ramaRaw : undefined;

    const data = await jornadaService.listJornadasDisponibles({
      concesionId,
      sucursalId: operational.sucursalId,
      rama,
    });
    res.status(200).json({ success: true, data });
  },
);
