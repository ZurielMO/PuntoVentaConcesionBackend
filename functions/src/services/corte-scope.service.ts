import { Request } from "express";
import {
  resolveCorteScope,
  type CorteRequestedScope,
  type CorteScopeFilters,
} from "../domain/cortes/corte-scope";
import { getOperationalListFiltersAsync } from "../utils/list-filters.util";
import { ApiError } from "../utils/api-error";
import { getUserById } from "./user.service";
import { buildJornadaId, resolveCajaActivaParaVendedor } from "./asignacion-caja.service";
import { resolveJornadaPrimaria } from "./jornada.service";

const queryString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const resolveCorteRequestScope = async (
  req: Request,
  overrides: CorteRequestedScope = {},
): Promise<CorteScopeFilters> => {
  const requested: CorteRequestedScope = {
    concesionId: queryString(req.query.concesionId),
    sucursalId: queryString(req.query.sucursalId),
    cajaId: queryString(req.query.cajaId),
    idUser: queryString(req.query.idUser),
    inventarioId: queryString(req.query.inventarioId),
    sesionCajaId: queryString(req.query.sesionCajaId),
    ...overrides,
  };
  const scope = resolveCorteScope(req.user as Express.AuthenticatedUser, requested);

  if (scope.role !== "VENDEDOR" || scope.cajaId) return scope;
  const operational = await getOperationalListFiltersAsync(req);
  return operational.cajaId ? { ...scope, cajaId: operational.cajaId } : scope;
};

/** Resolves the mutually-exclusive server-owned unit used only by close. */
export const resolveCorteCloseScope = async (
  req: Request,
  sesionCajaId?: string,
): Promise<CorteScopeFilters> => {
  const requested: CorteRequestedScope = {
    concesionId: queryString(req.query.concesionId),
    sucursalId: queryString(req.query.sucursalId),
    cajaId: queryString(req.query.cajaId),
    idUser: queryString(req.query.idUser),
    ...(sesionCajaId ? { sesionCajaId } : {}),
  };
  const scope = resolveCorteScope(req.user as Express.AuthenticatedUser, requested);
  const sellerId = scope.role === "VENDEDOR" ? req.user?.uid : scope.idUser;
  if (!scope.concesionId || !sellerId) {
    throw new ApiError(400, "El cierre requiere concesion, vendedor y caja", true, "INVALID_CORTE_CLOSE_UNIT");
  }

  const seller = await getUserById(sellerId);
  const sucursalId = typeof seller.sucursalId === "string" ? seller.sucursalId : "";
  const sellerRole = String(seller.rol ?? "").toUpperCase();
  if (seller.concesionId !== scope.concesionId || !sucursalId
    || (scope.sucursalId && scope.sucursalId !== sucursalId)
    || !sellerRole.includes("VENDEDOR")) {
    throw new ApiError(403, "El vendedor no pertenece al alcance autorizado", true, "INVALID_CORTE_CLOSE_UNIT");
  }

  const jornada = await resolveJornadaPrimaria();
  const assigned = await resolveCajaActivaParaVendedor({
    vendedorUid: sellerId,
    jornadaId: buildJornadaId(jornada.fecha, jornada.jornadaNumero),
    sucursalId,
    fallbackCajaId: typeof seller.cajaId === "string" ? seller.cajaId : null,
  });
  if (!assigned || (scope.role !== "VENDEDOR" && scope.cajaId !== assigned.cajaId)) {
    throw new ApiError(409, "Vendedor y caja no tienen una asignacion activa valida", true, "INVALID_CORTE_CLOSE_UNIT");
  }
  return {
    role: scope.role,
    concesionId: scope.concesionId,
    sucursalId,
    cajaId: assigned.cajaId,
    idUser: sellerId,
    ...(sesionCajaId ? { sesionCajaId } : {}),
  };
};

export const toOperationalCorteFilters = (
  scope: CorteScopeFilters,
) => ({
  ...(scope.concesionId ? { concesionId: scope.concesionId } : {}),
  ...(scope.sucursalId ? { sucursalId: scope.sucursalId } : {}),
  ...(scope.cajaId ? { cajaId: scope.cajaId } : {}),
  ...(scope.idUser ? { idUser: scope.idUser } : {}),
  ...(scope.inventarioId ? { inventarioId: scope.inventarioId } : {}),
});
