import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as corteService from "../../services/corte.service";
import * as corteReporteService from "../../services/corte-reporte.service";
import {
  resolveCorteRequestScope,
  toOperationalCorteFilters,
} from "../../services/corte-scope.service";
import { corteDocumentMatchesScope } from "../../domain/cortes/corte-scope";

export const getCorteResumen = asyncHandler(async (req: Request, res: Response) => {
  const scope = await resolveCorteRequestScope(req);
  const data = await corteService.buildCorteResumen(toOperationalCorteFilters(scope));
  res.status(200).json({ success: true, data });
});

export const getReporteCortes = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  const scope = await resolveCorteRequestScope(req);
  const jornadaRaw = typeof req.query.jornada === "string" ? req.query.jornada : undefined;
  const jornadaNumero = jornadaRaw ? Number(jornadaRaw) : undefined;
  const data = await corteReporteService.buildReporteCortes({
    concesionId: scope.concesionId,
    sucursalId: scope.sucursalId,
    cajaId: scope.cajaId,
    idUser: scope.idUser,
    inventarioId: scope.inventarioId,
    jornadaId: typeof req.query.jornadaId === "string" ? req.query.jornadaId : undefined,
    fecha: typeof req.query.fecha === "string" ? req.query.fecha : undefined,
    jornadaNumero: jornadaNumero != null && Number.isFinite(jornadaNumero) ? jornadaNumero : undefined,
  });
  res.status(200).json({ success: true, data });
});

export const getCortes = asyncHandler(async (req: Request, res: Response) => {
  const scope = await resolveCorteRequestScope(req);
  const data = await corteService.listCortesLegacy({
    ...toOperationalCorteFilters(scope),
    ...(scope.sesionCajaId ? { sesionCajaId: scope.sesionCajaId } : {}),
    jornadaId: typeof req.query.jornadaId === "string" ? req.query.jornadaId : undefined,
  });
  res.status(200).json({ success: true, data, count: data.length });
});

export const getCortesHistorial = asyncHandler(async (req: Request, res: Response) => {
  const scope = await resolveCorteRequestScope(req);
  const page = await corteService.listCortesPage({
    ...toOperationalCorteFilters(scope),
    ...(scope.sesionCajaId ? { sesionCajaId: scope.sesionCajaId } : {}),
    jornadaId: typeof req.query.jornadaId === "string" ? req.query.jornadaId : undefined,
  }, {
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  const meta = { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: page.limit };
  res.status(200).json({
    success: true,
    data: page.items,
    items: page.items,
    count: page.items.length,
    meta,
  });
});

export const getCorteById = asyncHandler(async (req: Request, res: Response) => {
  const scope = await resolveCorteRequestScope(req);
  const data = await corteService.getCorteById(req.params.id);
  if (!corteDocumentMatchesScope(scope, data)) {
    throw new ApiError(403, "No tienes acceso a este corte", true, "FORBIDDEN");
  }
  res.status(200).json({ success: true, data });
});

export const getDashboardCortes = asyncHandler(async (req: Request, res: Response) => {
  const scope = await resolveCorteRequestScope(req);
  const data = await corteService.buildCorteDashboard(scope);
  res.status(200).json({ success: true, data });
});
