import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as jornadaService from "../../services/jornada.service";

export const getJornadaActiva = asyncHandler(
  async (_req: Request, res: Response) => {
    const jornada_activa = await jornadaService.getJornadaActiva();
    res.status(200).json({ success: true, jornada_activa });
  },
);
