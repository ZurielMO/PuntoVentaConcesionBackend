import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as zonaService from "../../services/zona.service";
import { isSuperAdmin } from "../../utils/roles.middlewares";

export const getZonas = asyncHandler(async (req: Request, res: Response) => {
  const includeInactive =
    isSuperAdmin(req.user) &&
    String(req.query.includeInactive).toLowerCase() === "true";
  const data = await zonaService.listZonas(includeInactive);
  res.status(200).json({ success: true, data, count: data.length });
});

export const getZonaById = asyncHandler(async (req: Request, res: Response) => {
  const data = await zonaService.getZonaById(req.params.id);
  res.status(200).json({ success: true, data });
});
