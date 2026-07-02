import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as asignacionService from "../../services/asignacion-caja.service";
import {
  getUserConcessionId,
  isSuperAdmin,
  validateUser,
} from "../../utils/roles.middlewares";

export const getAsignacionesCajas = asyncHandler(
  async (req: Request, res: Response) => {
    const jornadaId = req.params.jornadaId;
    const sucursalId = req.query.sucursalId as string | undefined;
    const user = validateUser(req);
    const concesionId = isSuperAdmin(user)
      ? (req.query.concesionId as string | undefined)
      : getUserConcessionId(user);

    const data = await asignacionService.listAsignacionesCajas({
      jornadaId,
      sucursalId,
      concesionId,
    });
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const upsertAsignacionesCajas = asyncHandler(
  async (req: Request, res: Response) => {
    const user = validateUser(req);
    const concesionId = isSuperAdmin(user)
      ? (req.body.concesionId as string | undefined) ?? getUserConcessionId(user)
      : getUserConcessionId(user);

    if (!concesionId) {
      throw new ApiError(
        400,
        "Se requiere concesionId",
        true,
        "MISSING_CONCESSION",
      );
    }

    const { sucursalId, asignaciones } = req.body;
    const data = await asignacionService.upsertAsignacionesCajas({
      jornadaId: req.params.jornadaId,
      concesionId,
      sucursalId,
      asignaciones,
    });
    res.status(200).json({ success: true, data, message: "Asignaciones guardadas" });
  },
);

export const getMiCajaActiva = asyncHandler(
  async (req: Request, res: Response) => {
    const user = validateUser(req);
    const sucursalId = req.query.sucursalId as string;
    const jornadaId = req.params.jornadaId;
    if (!sucursalId) {
      throw new ApiError(
        400,
        "Se requiere sucursalId",
        true,
        "MISSING_QUERY",
      );
    }

    const caja = await asignacionService.resolveCajaActivaParaVendedor({
      vendedorUid: user.uid as string,
      jornadaId,
      sucursalId,
      fallbackCajaId: (user.cajaId as string | null | undefined) ?? null,
    });

    res.status(200).json({ success: true, data: caja });
  },
);
