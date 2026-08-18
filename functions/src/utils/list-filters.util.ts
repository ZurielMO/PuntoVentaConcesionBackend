import { Request } from "express";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import {
  buildJornadaId,
  resolveCajaActivaParaVendedor,
} from "../services/asignacion-caja.service";
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
};

const inventariosCol = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);

/** Deriva filtros de listado según rol del usuario autenticado (sync, legacy). */
export const getOperationalListFilters = (req: Request): OperationalListFilters => {
  const user = req.user;
  if (!user) return {};

  if (isSuperAdmin(user)) {
    const concesionId = req.query.concesionId as string | undefined;
    return {
      concesionId,
      sucursalId: req.query.sucursalId as string | undefined,
      cajaId: req.query.cajaId as string | undefined,
      inventarioId: req.query.inventarioId as string | undefined,
    };
  }

  const concesionId = getUserConcessionId(user);
  if (!concesionId) return { concesionId: "__none__" };

  if (isVendedor(user)) {
    const queryCajaId = req.query.cajaId as string | undefined;
    return {
      concesionId,
      sucursalId: getUserSucursalId(user),
      cajaId:
        queryCajaId?.trim() ||
        (user.cajaId as string | undefined) ||
        undefined,
      inventarioId: req.query.inventarioId as string | undefined,
    };
  }

  if (isAdminCerveceria(user)) {
    return {
      concesionId,
      sucursalId: getUserSucursalId(user),
      cajaId: req.query.cajaId as string | undefined,
      inventarioId: req.query.inventarioId as string | undefined,
    };
  }

  if (isAdmin(user)) {
    return {
      concesionId,
      sucursalId: req.query.sucursalId as string | undefined,
      cajaId: req.query.cajaId as string | undefined,
      inventarioId: req.query.inventarioId as string | undefined,
    };
  }

  return { concesionId };
};

/** Resuelve caja activa por jornada para vendedores al listar ventas. */
export const getOperationalListFiltersAsync = async (
  req: Request,
): Promise<OperationalListFilters> => {
  const base = getOperationalListFilters(req);
  const user = req.user;
  if (!user || !isVendedor(user)) return base;

  const sucursalId = base.sucursalId;
  const inventarioId = base.inventarioId;
  const queryCajaId = (req.query.cajaId as string | undefined)?.trim() || undefined;
  const fallbackCajaId = (user.cajaId as string | null | undefined) ?? null;

  if (queryCajaId) {
    return { ...base, cajaId: queryCajaId };
  }

  if (!sucursalId || !inventarioId) {
    return { ...base, cajaId: base.cajaId ?? fallbackCajaId ?? undefined };
  }

  const invDoc = await inventariosCol().doc(inventarioId).get();
  if (!invDoc.exists) {
    return { ...base, cajaId: base.cajaId ?? fallbackCajaId ?? undefined };
  }

  const inv = invDoc.data() ?? {};
  const jornadaId = buildJornadaId(
    String(inv.jornada_fecha ?? ""),
    Number(inv.jornada_numero ?? 0),
  );

  const resolved = await resolveCajaActivaParaVendedor({
    vendedorUid: user.uid as string,
    jornadaId,
    sucursalId,
    fallbackCajaId,
  });

  return {
    ...base,
    cajaId: resolved?.cajaId ?? base.cajaId ?? fallbackCajaId ?? undefined,
  };
};
