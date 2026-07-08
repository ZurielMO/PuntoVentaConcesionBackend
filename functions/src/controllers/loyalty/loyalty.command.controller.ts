import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as loyaltyPointsService from "../../services/loyalty-points.service";
import * as abonadoService from "../../services/abonado.service";

export const assignVentaPoints = asyncHandler(
  async (req: Request, res: Response) => {
    const { ventaId } = req.params;
    const { memberId, total } = req.body as {
      memberId: string;
      total: number;
    };

    const result = await loyaltyPointsService.assignPointsBySale({
      memberId,
      total,
      ventaId,
    });

    res.status(200).json({
      success: true,
      data: result,
      message: "Puntos asignados correctamente",
    });
  },
);

export const consumeAbonadoBenefit = asyncHandler(
  async (req: Request, res: Response) => {
    const { memberId, benefitId } = req.params;
    const { ventaId } = req.body as { ventaId: string };

    const result = await abonadoService.consumeAbonadoBenefit({
      memberId,
      benefitId,
      ventaId,
    });

    res.status(200).json({
      success: true,
      data: result,
      message: "Beneficio consumido correctamente",
    });
  },
);
