import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as authService from "../../services/auth.service";
import { ApiError } from "../../utils/api-error";

/**
 * Login con Firebase ID token (legacy).
 * Ya no se acepta: el POS usa JWT de app-oficial-leon.
 */
export const login = asyncHandler(async (_req: Request, _res: Response) => {
  throw new ApiError(
    400,
    "Este endpoint ya no está disponible. Usa POST /auth/login/password",
    true,
    "DEPRECATED",
  );
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
