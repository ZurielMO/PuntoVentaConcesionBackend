import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as cinepolisPuntosService from "../../services/cinepolis-puntos.service";
import * as loyaltyPointsService from "../../services/loyalty-points.service";
import * as loyaltyOutboxService from "../../services/loyalty-outbox.service";
import * as abonadoService from "../../services/abonado.service";
import * as detalleVentaService from "../../services/detalle-venta.service";
import { ApiError } from "../../utils/api-error";

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
      // Se propagan para que, si la operación queda pendiente, el registro
      // conserve dónde se hizo la venta y se pueda auditar por concesión.
      concesionId: comprobante?.concesionId as string | undefined,
      sucursalId: comprobante?.sucursalId as string | undefined,
      cajaId: comprobante?.cajaId as string | undefined,
    });

    res.status(200).json({
      success: true,
      data: result,
      message:
        result.status === "PENDING"
          ? "Venta registrada. Los puntos se acreditarán en cuanto Club León esté disponible"
          : "Puntos asignados correctamente",
    });
  },
);

/**
 * Reintegra al ledger oficial las acumulaciones que quedaron encoladas por una
 * caída de BackendCL. Seguro de reejecutar: cada venta se acredita una sola vez.
 */
export const reprocessPendingLoyalty = asyncHandler(
  async (req: Request, res: Response) => {
    const rawLimit = Number((req.query.limit as string | undefined) ?? 50);
    const limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50, 1),
      200,
    );

    const result = await loyaltyPointsService.reprocessPendingAccruals(limit);
    const restantes = await loyaltyOutboxService.countPendingAccruals();

    res.status(200).json({
      success: true,
      data: { ...result, restantes },
      message: `Reproceso terminado: ${result.completadas} acreditadas, ${result.yaProcesadas} ya estaban en el ledger, ${result.fallidas} fallidas`,
    });
  },
);

export const listPendingLoyalty = asyncHandler(
  async (req: Request, res: Response) => {
    const rawLimit = Number((req.query.limit as string | undefined) ?? 50);
    const limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50, 1),
      200,
    );
    const [items, totales] = await Promise.all([
      loyaltyOutboxService.listPendingAccruals(limit),
      loyaltyOutboxService.countPendingAccruals(),
    ]);
    res.status(200).json({ success: true, data: { items, totales } });
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

export const assignCinepolisPoints = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;
    if (!user?.uid || !user.email) {
      throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
    }
    const { memberId, dinero, comentario } = req.body as {
      memberId: string;
      dinero: number;
      comentario?: string;
    };

    const result = await cinepolisPuntosService.assignCinepolisPoints({
      memberId,
      dinero,
      comentario,
      cashierUid: user.uid,
      cashierEmail: user.email,
    });

    res.status(200).json({
      success: true,
      data: result,
      message: "Puntos asignados correctamente",
    });
  },
);
