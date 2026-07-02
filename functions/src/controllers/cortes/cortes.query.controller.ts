import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as corteService from "../../services/corte.service";
import { getOperationalListFilters } from "../../utils/list-filters.util";

export const getCortes = asyncHandler(async (req: Request, res: Response) => {
  const filters = getOperationalListFilters(req);
  const data = await corteService.listCortes(filters);
  res.status(200).json({ success: true, data, count: data.length });
});

export const getCorteById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await corteService.getCorteById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
