import { ApiError } from "../../utils/api-error";

export type CorteScopeRole = "VENDEDOR" | "ADMIN" | "SUPERADMIN";

export interface CorteScopeFilters {
  role: CorteScopeRole;
  concesionId?: string;
  sucursalId?: string;
  cajaId?: string;
  idUser?: string;
  inventarioId?: string;
  sesionCajaId?: string;
}

export type CorteRequestedScope = Omit<CorteScopeFilters, "role">;

type AuthenticatedIdentity = {
  uid: string;
  rol?: string;
  admin?: boolean;
  isAdmin?: boolean;
  concesionId?: unknown;
  idConcesion?: unknown;
  concessionId?: unknown;
  sucursalId?: unknown;
  idSucursal?: unknown;
  cajaId?: unknown;
  sesionCajaId?: unknown;
};

const cleanScopeId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 128 || /[\u0000-\u001f]/.test(trimmed)) {
    throw new ApiError(400, "Filtro de alcance invalido", true, "INVALID_CORTE_SCOPE");
  }
  return trimmed;
};

const roleFrom = (user: AuthenticatedIdentity): CorteScopeRole => {
  const raw = String(user.rol ?? "").toUpperCase();
  if (user.admin === true || user.isAdmin === true || ["SUPERADMIN", "CONCESION_SUPERADMIN", "CONCESIO_SUPERADMIN"].includes(raw)) {
    return "SUPERADMIN";
  }
  if (["ADMIN", "CONCESION_ADMIN", "CONCESIO_ADMIN"].includes(raw)) return "ADMIN";
  if (["VENDEDOR", "EMPLEADO", "CONCESION_VENDEDOR", "CONCESIO_VENDEDOR"].includes(raw)) return "VENDEDOR";
  throw new ApiError(403, "Rol sin permisos para consultar cortes", true, "FORBIDDEN");
};

const authenticatedConcession = (user: AuthenticatedIdentity): string | undefined =>
  cleanScopeId(user.concesionId ?? user.idConcesion ?? user.concessionId);

const authenticatedBranch = (user: AuthenticatedIdentity): string | undefined =>
  cleanScopeId(user.sucursalId ?? user.idSucursal);

const requestedFilters = (requested: CorteRequestedScope): CorteRequestedScope => {
  const result: CorteRequestedScope = {};
  const fields: Array<keyof CorteRequestedScope> = [
    "concesionId",
    "sucursalId",
    "cajaId",
    "idUser",
    "inventarioId",
    "sesionCajaId",
  ];
  for (const field of fields) {
    const value = cleanScopeId(requested[field]);
    if (value) result[field] = value;
  }
  return result;
};

/**
 * Resolves the only scope that a cortes handler may use. Requested role/scope
 * values never grant authority: seller and admin authority comes exclusively
 * from the authenticated identity.
 */
export const resolveCorteScope = (
  user: AuthenticatedIdentity,
  requested: CorteRequestedScope,
): CorteScopeFilters => {
  if (!user?.uid) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }
  const role = roleFrom(user);
  const filters = requestedFilters(requested);

  if (role === "SUPERADMIN") {
    return { role, ...filters };
  }

  const concesionId = authenticatedConcession(user);
  if (!concesionId) {
    throw new ApiError(403, "Usuario sin concesion asignada", true, "FORBIDDEN");
  }

  if (role === "ADMIN") {
    return {
      role,
      concesionId,
      ...(filters.sucursalId ? { sucursalId: filters.sucursalId } : {}),
      ...(filters.cajaId ? { cajaId: filters.cajaId } : {}),
      ...(filters.idUser ? { idUser: filters.idUser } : {}),
      ...(filters.inventarioId ? { inventarioId: filters.inventarioId } : {}),
      ...(filters.sesionCajaId ? { sesionCajaId: filters.sesionCajaId } : {}),
    };
  }

  const sucursalId = authenticatedBranch(user);
  if (!sucursalId) {
    throw new ApiError(403, "Vendedor sin sucursal asignada", true, "FORBIDDEN");
  }
  const cajaId = cleanScopeId(user.cajaId);
  const sesionCajaId = cleanScopeId(user.sesionCajaId);
  return {
    role,
    concesionId,
    sucursalId,
    ...(cajaId ? { cajaId } : {}),
    idUser: user.uid,
    ...(filters.inventarioId ? { inventarioId: filters.inventarioId } : {}),
    ...(sesionCajaId ? { sesionCajaId } : {}),
  };
};

export const corteDocumentMatchesScope = (
  scope: CorteScopeFilters,
  document: Readonly<Record<string, unknown>>,
): boolean => {
  if (scope.concesionId && document.concesionId !== scope.concesionId) return false;
  if (scope.sucursalId && document.sucursalId !== scope.sucursalId) return false;
  if (scope.cajaId && document.cajaId !== scope.cajaId) return false;
  if (scope.idUser && document.idUser !== scope.idUser) return false;
  if (scope.sesionCajaId && document.sesionCajaId !== scope.sesionCajaId) return false;
  return true;
};
