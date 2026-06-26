import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as zonaService from "../../services/zona.service";

export const getZonas = asyncHandler(async (_req: Request, res: Response) => {
  const data = await zonaService.listZonas();
  res.status(200).json({ success: true, data, count: data.length });
});

export const getZonaById = asyncHandler(async (req: Request, res: Response) => {
  const data = await zonaService.getZonaById(req.params.id);
  res.status(200).json({ success: true, data });
});
