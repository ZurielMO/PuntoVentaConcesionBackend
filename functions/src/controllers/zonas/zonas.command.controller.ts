import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as zonaService from "../../services/zona.service";

export const createZona = asyncHandler(async (req: Request, res: Response) => {
  const data = await zonaService.createZona(req.body);
  res.status(201).json({ success: true, data, message: "Zona creada" });
});

export const updateZona = asyncHandler(async (req: Request, res: Response) => {
  const data = await zonaService.updateZona(req.params.id, req.body);
  res.status(200).json({ success: true, data, message: "Zona actualizada" });
});

export const deleteZona = asyncHandler(async (req: Request, res: Response) => {
  await zonaService.softDeleteZona(req.params.id);
  res.status(204).send();
});


//prueba commit de deploy
//prueba commit de deploy 2
//prueba commit de deploy 3.1

