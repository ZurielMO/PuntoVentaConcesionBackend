import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as trabajadorClubService from "../../services/trabajador-club.service";

export const searchTrabajadorCandidate = asyncHandler(
  async (req: Request, res: Response) => {
    const email = req.query.email;
    if (typeof email !== "string" || !email.trim()) {
      throw new ApiError(400, "El parámetro email es requerido", true, "MISSING_EMAIL");
    }

    const data = await trabajadorClubService.searchUsuarioByEmail(email);
    res.status(200).json({ success: true, data });
  },
);

export const listTrabajadoresClub = asyncHandler(
  async (req: Request, res: Response) => {
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" && limitRaw.trim()
        ? Number.parseInt(limitRaw, 10)
        : undefined;

    const data = await trabajadorClubService.listTrabajadoresClub({ limit });
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const listCortesiasTrabajador = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await trabajadorClubService.listCortesiasTrabajador(
      req.params.uid,
    );
    res.status(200).json({ success: true, data, count: data.length });
  },
);
