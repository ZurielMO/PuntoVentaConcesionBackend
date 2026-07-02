import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as userService from "../../services/user.service";
import {
  getUserConcessionId,
  isSuperAdmin,
  validateUser,
} from "../../utils/roles.middlewares";

export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const concesionId = req.query.concesionId as string | undefined;
  const data = await userService.listUsers(concesionId);
  res.status(200).json({ success: true, data, count: data.length });
});

export const getVendedoresEquipo = asyncHandler(
  async (req: Request, res: Response) => {
    const user = validateUser(req);
    const concesionId = isSuperAdmin(user)
      ? (req.query.concesionId as string | undefined)
      : getUserConcessionId(user);

    if (!concesionId) {
      throw new ApiError(
        400,
        "Se requiere concesionId",
        true,
        "MISSING_CONCESSION",
      );
    }

    const data = await userService.listVendedoresByConcesion(concesionId);
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const data = await userService.getUserById(req.params.id);
  res.status(200).json({ success: true, data });
});
