import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as comboService from "../../services/combo.service";
import {
  getUserConcessionId,
  isSuperAdmin,
} from "../../utils/roles.middlewares";

const getEffectiveConcesionId = (req: Request): string | undefined => {
  const user = req.user;
  if (!user || isSuperAdmin(user)) {
    return req.query.concesionId as string | undefined;
  }
  return getUserConcessionId(user);
};

export const getCombos = asyncHandler(async (req: Request, res: Response) => {
  // Solo SUPERADMIN puede ver combos inactivos (soft-deleted)
  const includeInactive =
    isSuperAdmin(req.user) &&
    String(req.query.includeInactive).toLowerCase() === "true";

  const data = await comboService.listCombos({
    concesionId: getEffectiveConcesionId(req),
    includeInactive,
  });
  res.status(200).json({ success: true, data, count: data.length });
});

export const getComboById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await comboService.getComboById(req.params.id);

    if (!isSuperAdmin(req.user)) {
      const userConcessionId = getUserConcessionId(req.user);
      if (
        !userConcessionId ||
        (data as { concesion_id?: string }).concesion_id !== userConcessionId
      ) {
        throw new ApiError(403, "No tienes acceso a este combo", true, "FORBIDDEN");
      }
    }

    res.status(200).json({ success: true, data });
  },
);
