import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as loyaltyPointsService from "../../services/loyalty-points.service";
import * as abonadoService from "../../services/abonado.service";

export const getPointsConversion = asyncHandler(
  async (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: {
        puntosPorPesoCanje: loyaltyPointsService.PUNTOS_POR_PESO_CANJE,
        pesoPorPunto: 1 / loyaltyPointsService.PUNTOS_POR_PESO_CANJE,
        puntosPorPesoAcumulacion: loyaltyPointsService.calcularPuntosPorVenta(1),
      },
    });
  },
);

export const getClubMember = asyncHandler(async (req: Request, res: Response) => {
  const member = await loyaltyPointsService.getClubMember(req.params.memberId);
  res.status(200).json({ success: true, data: member });
});

export const getAbonado = asyncHandler(async (req: Request, res: Response) => {
  const abonado = await abonadoService.verifyAbonado(req.params.memberId);
  res.status(200).json({ success: true, data: abonado });
});
