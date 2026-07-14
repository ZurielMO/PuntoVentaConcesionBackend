import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as corteService from "../../services/corte.service";
import { resolveCorteCloseScope } from "../../services/corte-scope.service";
import { getUserConcessionId, getUserSucursalId } from "../../utils/roles.middlewares";
import type { CerrarCorteInput } from "../../middleware/validators/corte.validator";

export const createCorte = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user;
  if (!user?.uid) throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  const concesionId = getUserConcessionId(user);
  if (!concesionId) throw new ApiError(403, "Usuario sin concesion asignada", true, "FORBIDDEN");

  const data = await corteService.createCorte(
    {
      concesionId,
      sucursalId: getUserSucursalId(user) ?? null,
      idUser: user.uid,
      ventaId: typeof req.query.idventa === "string" ? req.query.idventa : null,
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
  if (!user?.uid) throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  const closeInput = req.body as CerrarCorteInput;
  const sesionCajaId = closeInput.sesionCajaId;
  const scope = await resolveCorteCloseScope(req, sesionCajaId);
  const data = await corteService.cerrarCorte(
    { actorUid: user.uid },
    scope,
    closeInput,
    req.get("Idempotency-Key") ?? undefined,
  );
  res.status(data.idempotentReplay ? 200 : 201).json({
    success: true,
    data,
    message: data.idempotentReplay ? "Corte cerrado recuperado" : "Corte cerrado",
  });
});
