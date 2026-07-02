import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as corteService from "../../services/corte.service";
import {
  getUserConcessionId,
  getUserSucursalId,
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
