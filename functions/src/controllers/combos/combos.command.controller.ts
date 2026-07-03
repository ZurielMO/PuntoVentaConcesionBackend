import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as comboService from "../../services/combo.service";

export const createCombo = asyncHandler(async (req: Request, res: Response) => {
  const { concesionId, ...data } = req.body;
  const combo = await comboService.createCombo(concesionId, data, {
    uid: req.user?.uid ?? null,
    nombre: (req.user?.nombre as string | undefined) ?? null,
  });
  res.status(201).json({ success: true, data: combo, message: "Combo creado" });
});

export const updateCombo = asyncHandler(async (req: Request, res: Response) => {
  const data = await comboService.updateCombo(req.params.id, req.body);
  res.status(200).json({ success: true, data, message: "Combo actualizado" });
});

export const deleteCombo = asyncHandler(async (req: Request, res: Response) => {
  await comboService.softDeleteCombo(req.params.id);
  res.status(204).send();
});

export const hardDeleteCombo = asyncHandler(
  async (req: Request, res: Response) => {
    await comboService.hardDeleteCombo(req.params.id);
    res.status(204).send();
  },
);
