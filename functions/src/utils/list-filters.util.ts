import { Request } from "express";
import {
  getUserConcessionId,
  getUserSucursalId,
  isSuperAdmin,
  isVendedor,
} from "./roles.middlewares";

export type OperationalListFilters = {
  concesionId?: string;
  sucursalId?: string;
  idUser?: string;
};

/** Deriva filtros de listado según rol del usuario autenticado. */
export const getOperationalListFilters = (req: Request): OperationalListFilters => {
  const user = req.user;
  if (!user) return {};

  if (isSuperAdmin(user)) {
    const concesionId = req.query.concesionId as string | undefined;
    return concesionId ? { concesionId } : {};
  }

  const concesionId = getUserConcessionId(user);
  if (!concesionId) return { concesionId: "__none__" };

  if (isVendedor(user)) {
    return {
      concesionId,
      sucursalId: getUserSucursalId(user),
      idUser: user.uid,
    };
  }

  return { concesionId };
};
