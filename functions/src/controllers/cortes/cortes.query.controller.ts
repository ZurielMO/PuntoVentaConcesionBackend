import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as corteService from "../../services/corte.service";

export const getCortes = asyncHandler(async (_req: Request, res: Response) => {
  const data = await corteService.listCortes();
  res.status(200).json({ success: true, data, count: data.length });
});

export const getCorteById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await corteService.getCorteById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
