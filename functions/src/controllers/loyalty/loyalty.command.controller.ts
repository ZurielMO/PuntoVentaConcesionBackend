import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as loyaltyPointsService from "../../services/loyalty-points.service";
import * as abonadoService from "../../services/abonado.service";
import * as detalleVentaService from "../../services/detalle-venta.service";

export const assignVentaPoints = asyncHandler(
  async (req: Request, res: Response) => {
    const { ventaId } = req.params;
    const { memberId, total } = req.body as {
      memberId: string;
      total: number;
    };

    const comprobante =
      await detalleVentaService.findComprobanteByVentaId(ventaId);
    if (
      comprobante &&
      !loyaltyPointsService.ventaAcumulaPuntos({
        metodoPago: comprobante.metodoPago as string | undefined,
        puntosUsados: comprobante.puntosUsados as number | undefined,
      })
    ) {
      res.status(200).json({
        success: true,
        data: {
          memberId,
          montoVenta: total,
          puntosAsignados: 0,
          puntosActuales: 0,
          descripcion: `Venta POS ${ventaId}`,
          externalResponse: null,
        },
        message: "Venta pagada con puntos: no se acumulan puntos",
      });
      return;
    }

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
