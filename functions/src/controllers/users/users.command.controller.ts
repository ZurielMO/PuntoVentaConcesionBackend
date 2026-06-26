import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as userService from "../../services/user.service";

export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const data = await userService.createUser(req.body);
  res.status(201).json({ success: true, data, message: "Usuario creado" });
});

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const data = await userService.updateUser(req.params.id, req.body);
  res.status(200).json({ success: true, data, message: "Usuario actualizado" });
});

export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  await userService.softDeleteUser(req.params.id);
  res.status(204).send();
});
