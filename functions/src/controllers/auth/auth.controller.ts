import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as authService from "../../services/auth.service";

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { idToken } = req.body;
  const usuario = await authService.verifyIdToken(idToken);
  res.status(200).json({ success: true, token: idToken, usuario });
});

export const loginWithPassword = asyncHandler(
  async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const result = await authService.loginWithPassword(email, password);
    res
      .status(200)
      .json({ success: true, token: result.token, usuario: result.usuario });
  },
);

export const me = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json({ success: true, usuario: req.user });
});
