import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as trabajadorClubService from "../../services/trabajador-club.service";

export const addTrabajadorClub = asyncHandler(
  async (req: Request, res: Response) => {
    const { uid, email } = req.body as { uid?: string; email?: string };
    const data = await trabajadorClubService.addTrabajadorClub(
      { uid, email },
      req.user?.uid ?? "unknown",
    );
    res.status(201).json({
      success: true,
      data,
      message: "Trabajador del club agregado",
    });
  },
);

export const updateCortesiaCanjeada = asyncHandler(
  async (req: Request, res: Response) => {
    const { cortesiaCanjeada } = req.body as { cortesiaCanjeada: boolean };
    const data = await trabajadorClubService.updateCortesiaCanjeada(
      req.params.uid,
      req.params.cortesiaId,
      cortesiaCanjeada,
    );
    res.status(200).json({
      success: true,
      data,
      message: "Cortesía actualizada",
    });
  },
);

export const removeTrabajadorClub = asyncHandler(
  async (req: Request, res: Response) => {
    await trabajadorClubService.removeTrabajadorClub(req.params.uid);
    res.status(204).send();
  },
);
