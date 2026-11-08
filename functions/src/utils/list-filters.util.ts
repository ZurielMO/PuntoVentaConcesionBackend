import { Request } from "express";
import {
  getUserConcessionId,
  getUserSucursalId,
  isSuperAdmin,
  isVendedor,
  isAdmin,
  isAdminCerveceria,
} from "./roles.middlewares";

export type OperationalListFilters = {
  concesionId?: string;
  sucursalId?: string;
  idUser?: string;
  cajaId?: string;
  inventarioId?: string;
  jornadaId?: string;
};

/** Deriva filtros de listado según rol del usuario autenticado (sync, legacy). */
export const getOperationalListFilters = (req: Request): OperationalListFilters => {
  const user = req.user;
  if (!user) return {};

  const jornadaId = req.query.jornadaId as string | undefined;

  if (isSuperAdmin(user)) {
    const concesionId = req.query.concesionId as string | undefined;
    return {
      concesionId,
      sucursalId: req.query.sucursalId as string | undefined,
      cajaId: req.query.cajaId as string | undefined,
      inventarioId: req.query.inventarioId as string | undefined,
      jornadaId,
    };
  }

  const concesionId = getUserConcessionId(user);
  if (!concesionId) return { concesionId: "__none__" };

  if (isVendedor(user)) {
    const cajaId = (req.query.cajaId as string | undefined)?.trim() || undefined;
    return {
      concesionId,
      sucursalId: getUserSucursalId(user),
      cajaId,
      // Sin caja indicada solo ve sus propias operaciones, no toda la sucursal.
      idUser: cajaId ? undefined : (user.uid as string | undefined),
      inventarioId: req.query.inventarioId as string | undefined,
      jornadaId,
    };
  }

  if (isAdminCerveceria(user)) {
    return {
      concesionId,
      sucursalId: getUserSucursalId(user),
      cajaId: req.query.cajaId as string | undefined,
      inventarioId: req.query.inventarioId as string | undefined,
      jornadaId,
    };
  }

  if (isAdmin(user)) {
    return {
      concesionId,
      sucursalId: req.query.sucursalId as string | undefined,
      cajaId: req.query.cajaId as string | undefined,
      inventarioId: req.query.inventarioId as string | undefined,
      jornadaId,
    };
  }

  return { concesionId, jornadaId };
};

/** Conserva la firma que usan los controladores; ya no consulta la caja del usuario. */
export const getOperationalListFiltersAsync = async (
  req: Request,
): Promise<OperationalListFilters> => getOperationalListFilters(req);
