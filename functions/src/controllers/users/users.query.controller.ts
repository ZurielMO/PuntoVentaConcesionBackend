import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as userService from "../../services/user.service";

export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const concesionId = req.query.concesionId as string | undefined;
  const data = await userService.listUsers(concesionId);
  res.status(200).json({ success: true, data, count: data.length });
});

export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const data = await userService.getUserById(req.params.id);
  res.status(200).json({ success: true, data });
});
