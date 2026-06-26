import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as corteService from "../../services/corte.service";

export const createCorte = asyncHandler(async (req: Request, res: Response) => {
  const ventaId = req.query.idventa as string | undefined;
  const idUser = req.query.idUser as string | undefined;
  const data = await corteService.createCorte(ventaId, idUser, req.body);
  res.status(201).json({ success: true, data, message: "Corte creado" });
});

export const updateCorte = asyncHandler(async (req: Request, res: Response) => {
  const data = await corteService.updateCorte(req.params.id, req.body);
  res.status(200).json({ success: true, data, message: "Corte actualizado" });
});
