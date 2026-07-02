import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as userService from "../../services/user.service";
import {
  getUserConcessionId,
  isSuperAdmin,
  validateUser,
} from "../../utils/roles.middlewares";

export const assignVendedor = asyncHandler(async (req: Request, res: Response) => {
  const user = validateUser(req);
  const adminConcesionId = getUserConcessionId(user);
  if (!adminConcesionId && !isSuperAdmin(user)) {
    throw new ApiError(
      403,
      "Usuario sin concesión asignada",
      true,
      "FORBIDDEN",
    );
  }

  const concesionId =
    (req.body.concesionId as string | undefined) ?? adminConcesionId;
  if (!concesionId) {
    throw new ApiError(400, "Se requiere concesionId", true, "MISSING_CONCESSION");
  }

  const data = await userService.assignVendedorToSucursalCaja(
    req.params.id,
    {
      sucursalId: req.body.sucursalId,
      cajaId: req.body.cajaId ?? null,
    },
    concesionId,
  );
  res.status(200).json({ success: true, data, message: "Vendedor asignado" });
});
