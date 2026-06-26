import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as concessionService from "../../services/concession.service";

export const getConcessions = asyncHandler(
  async (_req: Request, res: Response) => {
    const data = await concessionService.listConcessions();
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const getConcessionById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await concessionService.getConcessionById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
