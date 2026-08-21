import { Request, Response, NextFunction } from "express";
import { ApiError } from "./api-error";
import { asyncHandler } from "./error-handler";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { isCinepolisCashierEmail } from "../config/cinepolis.constants";
import { UserRole } from "../models";

// ---------------------------------------------------------------------------
// Helpers exportados
// ---------------------------------------------------------------------------

const col = (name: string) => firestorePos.collection(name);

export const getUserRole = (user: Express.AuthenticatedUser | undefined): UserRole | undefined => {
  if (!user) return undefined;
  const rol = typeof user.rol === "string" ? user.rol.toUpperCase() : undefined;
  if (!rol) return undefined;
  if (rol === "EMPLEADO" || rol === "CONCESION_VENDEDOR") return UserRole.VENDEDOR;
  if (rol === "CONCESION_SUPERADMIN") return UserRole.SUPERADMIN;
  if (rol === "CONCESION_ADMIN_CERVECERIA") return UserRole.ADMIN_CERVECERIA;
  if (rol === "CONCESION_ADMIN") return UserRole.ADMIN;
  return rol as UserRole | undefined;
};

export const isSuperAdmin = (user: Express.AuthenticatedUser | undefined): boolean => {
  const rol = getUserRole(user);
  return rol === UserRole.SUPERADMIN || user?.admin === true || user?.isAdmin === true;
};

export const isAdmin = (user: Express.AuthenticatedUser | undefined): boolean =>
  getUserRole(user) === UserRole.ADMIN;

/** Admin de sucursal de cervecería: permisos de admin, acotados a su sucursal. */
export const isAdminCerveceria = (
  user: Express.AuthenticatedUser | undefined,
): boolean => getUserRole(user) === UserRole.ADMIN_CERVECERIA;

export const isVendedor = (user: Express.AuthenticatedUser | undefined): boolean =>
  getUserRole(user) === UserRole.VENDEDOR;

export const getUserConcessionId = (user: Express.AuthenticatedUser | undefined): string | undefined =>
  (user?.concesionId as string | undefined) ||
  (user?.idConcesion as string | undefined) ||
  (user?.concessionId as string | undefined);

export const getUserSucursalId = (user: Express.AuthenticatedUser | undefined): string | undefined =>
  (user?.sucursalId as string | undefined) ||
  (user?.idSucursal as string | undefined);

export const validateUser = (req: Request): Express.AuthenticatedUser => {
  const user = req.user;
  if (!user) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }
  if (user.activo === false) {
    throw new ApiError(403, "La cuenta está desactivada", true, "USER_INACTIVE");
  }
  return user;
};

export const getSucursalConcessionId = async (sucursalId: string): Promise<string> => {
  const doc = await col(COLLECTIONS.SUCURSALES).doc(sucursalId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  return doc.data()?.concesion_id;
};

export const getInventarioConcessionId = async (inventarioId: string): Promise<string> => {
  const doc = await col(COLLECTIONS.INVENTARIOS).doc(inventarioId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const concesionId = doc.data()?.concesion_id;
  if (concesionId) return concesionId;
  return getSucursalConcessionId(doc.data()?.sucursal_id);
};

export const getInventarioSucursalId = async (inventarioId: string): Promise<string> => {
  const doc = await col(COLLECTIONS.INVENTARIOS).doc(inventarioId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  return doc.data()?.sucursal_id;
};

const getComprobanteData = async (id: string) => {
  const doc = await col(COLLECTIONS.COMPROBANTES_VENTA).doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Comprobante no encontrado", true, "NOT_FOUND");
  }
  return { id: doc.id, ...doc.data() } as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Gates simples por rol
// ---------------------------------------------------------------------------

export const requireAuthenticated = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  validateUser(req);
  next();
};

/** Solo el cajero Cinépolis (email fijo) puede asignar puntos de esa pantalla. */
export const requireCinepolisCashier = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const user = validateUser(req);
  if (!isCinepolisCashierEmail(user.email)) {
    throw new ApiError(
      403,
      "Esta operación es exclusiva del cajero Cinépolis",
      true,
      "FORBIDDEN",
    );
  }
  next();
};

export const requireSuperAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const user = validateUser(req);
  if (!isSuperAdmin(user)) {
    throw new ApiError(403, "Se requiere rol SUPERADMIN", true, "FORBIDDEN");
  }
  next();
};

export const requireAdminOrSuperAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const user = validateUser(req);
  if (!isSuperAdmin(user) && !isAdmin(user) && !isAdminCerveceria(user)) {
    throw new ApiError(403, "Se requiere rol ADMIN o SUPERADMIN", true, "FORBIDDEN");
  }
  next();
};

/** ADMIN de concesión (no SuperAdmin) con concesionId asignado. */
export const requireAdminConcesion = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const user = validateUser(req);
  if (isSuperAdmin(user)) {
    next();
    return;
  }
  if (!isAdmin(user)) {
    throw new ApiError(403, "Se requiere rol ADMIN", true, "FORBIDDEN");
  }
  if (!getUserConcessionId(user)) {
    throw new ApiError(
      403,
      "Usuario sin concesión asignada",
      true,
      "FORBIDDEN",
    );
  }
  next();
};

/** @deprecated Usar requireSuperAdmin para escritura de zonas */
export const requireZonaWriteAccess = requireSuperAdmin;

// ---------------------------------------------------------------------------
// Sucursales
// ---------------------------------------------------------------------------

export const requireSucursalReadAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const sucursalId = req.params.id || req.params.sucursalId;
    if (!sucursalId) return next();

    if (isVendedor(user) || isAdminCerveceria(user)) {
      const userSucursalId = getUserSucursalId(user);
      if (!userSucursalId || userSucursalId !== sucursalId) {
        throw new ApiError(403, "No tienes acceso a esta sucursal", true, "FORBIDDEN");
      }
      return next();
    }

    const concesionId = await getSucursalConcessionId(sucursalId);
    const userConcessionId = getUserConcessionId(user);
    if (!userConcessionId || userConcessionId !== concesionId) {
      throw new ApiError(403, "No tienes acceso a esta sucursal", true, "FORBIDDEN");
    }
    next();
  },
);

/** Sucursales y cajas: escritura exclusiva de SUPERADMIN. ADMIN solo consulta. */
export const requireSucursalWriteAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (!isSuperAdmin(user)) {
      throw new ApiError(
        403,
        "Solo SUPERADMIN puede administrar sucursales y cajas",
        true,
        "FORBIDDEN",
      );
    }
    next();
  },
);

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

export const requireProductReadAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const productId = req.params.id;
    if (!productId) return next();

    const userConcessionId = getUserConcessionId(user);
    if (!userConcessionId) {
      throw new ApiError(403, "Usuario sin concesión asignada", true, "FORBIDDEN");
    }

    const doc = await col(COLLECTIONS.PRODUCTS).doc(productId).get();
    if (!doc.exists) {
      throw new ApiError(404, "Producto no encontrado", true, "NOT_FOUND");
    }
    if (doc.data()?.concesion_id !== userConcessionId) {
      throw new ApiError(403, "No tienes acceso a este producto", true, "FORBIDDEN");
    }
    next();
  },
);

export const requireProductCreateAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();
    if (!isAdmin(user) && !isAdminCerveceria(user)) {
      throw new ApiError(403, "No tienes permisos administrativos", true, "FORBIDDEN");
    }

    const userConcessionId = getUserConcessionId(user);
    if (!userConcessionId) {
      throw new ApiError(403, "Usuario sin concesión asignada", true, "FORBIDDEN");
    }

    const targetConcessionId =
      (req.params.concesionId as string | undefined) ||
      (req.query.concesion_id as string | undefined) ||
      (req.body?.concesionId as string | undefined) ||
      (req.body?.concesion_id as string | undefined) ||
      userConcessionId;

    if (targetConcessionId !== userConcessionId) {
      throw new ApiError(403, "Solo puedes administrar productos de tu concesión", true, "FORBIDDEN");
    }

    req.body = { ...req.body, concesionId: targetConcessionId };
    next();
  },
);

export const requireProductWriteAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();
    if (!isAdmin(user) && !isAdminCerveceria(user)) {
      throw new ApiError(403, "No tienes permisos administrativos", true, "FORBIDDEN");
    }

    const userConcessionId = getUserConcessionId(user);
    if (!userConcessionId) {
      throw new ApiError(403, "Usuario sin concesión asignada", true, "FORBIDDEN");
    }

    const productId = req.params.id;
    const doc = await col(COLLECTIONS.PRODUCTS).doc(productId).get();
    if (!doc.exists) {
      throw new ApiError(404, "Producto no encontrado", true, "NOT_FOUND");
    }
    if (doc.data()?.concesion_id !== userConcessionId) {
      throw new ApiError(403, "Solo puedes administrar productos de tu concesión", true, "FORBIDDEN");
    }
    next();
  },
);

// ---------------------------------------------------------------------------
// Inventarios — SUPERADMIN escribe; ADMIN y VENDEDOR solo lectura por concesión
// ---------------------------------------------------------------------------

export const requireInventarioReadAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const inventarioId = req.params.id;
    if (!inventarioId) return next();

    const concesionId = await getInventarioConcessionId(inventarioId);
    const userConcessionId = getUserConcessionId(user);
    if (!userConcessionId || userConcessionId !== concesionId) {
      throw new ApiError(403, "No tienes acceso a este inventario", true, "FORBIDDEN");
    }

    next();
  },
);

export const requireInventarioWriteAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (!isSuperAdmin(user)) {
      throw new ApiError(
        403,
        "Solo SUPERADMIN puede modificar inventarios",
        true,
        "FORBIDDEN",
      );
    }
    next();
  },
);

// ---------------------------------------------------------------------------
// Detalle venta / comprobantes
// ---------------------------------------------------------------------------

export const requireDetalleVentaCreateAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const { concesionId, sucursalId, inventarioId } = req.params;
    const userConcessionId = getUserConcessionId(user);
    if (!userConcessionId || userConcessionId !== concesionId) {
      throw new ApiError(403, "No tienes acceso a esta concesión", true, "FORBIDDEN");
    }

    const invConcesionId = await getInventarioConcessionId(inventarioId);

    if (invConcesionId !== concesionId) {
      throw new ApiError(
        400,
        "Los parámetros de la venta no coinciden con el inventario",
        true,
        "BAD_REQUEST",
      );
    }

    const invSucursalId = await getInventarioSucursalId(inventarioId);
    if (invSucursalId && invSucursalId !== sucursalId) {
      throw new ApiError(
        400,
        "El inventario no pertenece a la sucursal indicada",
        true,
        "BAD_REQUEST",
      );
    }

    if (isVendedor(user) || isAdminCerveceria(user)) {
      const userSucursalId = getUserSucursalId(user);
      if (!userSucursalId || userSucursalId !== sucursalId) {
        throw new ApiError(403, "Solo puedes vender en tu sucursal asignada", true, "FORBIDDEN");
      }
    }

    next();
  },
);

export const requireDetalleVentaAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const data = await getComprobanteData(req.params.id);
    const userConcessionId = getUserConcessionId(user);
    if (!userConcessionId || data.concesionId !== userConcessionId) {
      throw new ApiError(403, "No tienes acceso a este comprobante", true, "FORBIDDEN");
    }

    if (isVendedor(user)) {
      const userSucursalId = getUserSucursalId(user);
      if (!userSucursalId || data.sucursalId !== userSucursalId) {
        throw new ApiError(403, "No tienes acceso a este comprobante", true, "FORBIDDEN");
      }
    }

    next();
  },
);

// ---------------------------------------------------------------------------
// Cortes
// ---------------------------------------------------------------------------

const getCorteData = async (id: string) => {
  const doc = await col(COLLECTIONS.CORTES).doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  }
  return { id: doc.id, ...doc.data() } as Record<string, unknown>;
};

export const requireCorteCreateAccess = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  validateUser(req);
  next();
};

export const requireCorteAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const data = await getCorteData(req.params.id);
    const userConcessionId = getUserConcessionId(user);

    if (isAdmin(user)) {
      if (!userConcessionId || data.concesionId !== userConcessionId) {
        throw new ApiError(403, "No tienes acceso a este corte", true, "FORBIDDEN");
      }
      return next();
    }

    if (isAdminCerveceria(user)) {
      const userSucursalId = getUserSucursalId(user);
      if (
        !userConcessionId ||
        data.concesionId !== userConcessionId ||
        (data.sucursalId && userSucursalId && data.sucursalId !== userSucursalId)
      ) {
        throw new ApiError(403, "No tienes acceso a este corte", true, "FORBIDDEN");
      }
      return next();
    }

    if (isVendedor(user)) {
      const userSucursalId = getUserSucursalId(user);
      if (
        !userConcessionId ||
        data.concesionId !== userConcessionId ||
        (data.sucursalId && userSucursalId && data.sucursalId !== userSucursalId) ||
        (data.idUser && data.idUser !== user.uid)
      ) {
        throw new ApiError(403, "No tienes acceso a este corte", true, "FORBIDDEN");
      }
    }

    next();
  },
);

export const requireCorteUpdateAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const data = await getCorteData(req.params.id);
    const userConcessionId = getUserConcessionId(user);

    if (isAdmin(user)) {
      if (!userConcessionId || data.concesionId !== userConcessionId) {
        throw new ApiError(403, "No tienes acceso a este corte", true, "FORBIDDEN");
      }
      return next();
    }

    throw new ApiError(403, "No tienes permisos para modificar cortes", true, "FORBIDDEN");
  },
);

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const getTicketData = async (id: string) => {
  const doc = await col(COLLECTIONS.TICKETS).doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Ticket no encontrado", true, "NOT_FOUND");
  }
  return { id: doc.id, ...doc.data() } as Record<string, unknown>;
};

export const requireTicketCreateAccess = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  validateUser(req);
  next();
};

export const requireTicketAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);
    if (isSuperAdmin(user)) return next();

    const data = await getTicketData(req.params.id);
    const userConcessionId = getUserConcessionId(user);

    if (isAdmin(user)) {
      if (!userConcessionId || data.concesionId !== userConcessionId) {
        throw new ApiError(403, "No tienes acceso a este ticket", true, "FORBIDDEN");
      }
      return next();
    }

    if (isAdminCerveceria(user)) {
      const userSucursalId = getUserSucursalId(user);
      if (
        !userConcessionId ||
        data.concesionId !== userConcessionId ||
        (data.sucursalId && userSucursalId && data.sucursalId !== userSucursalId)
      ) {
        throw new ApiError(403, "No tienes acceso a este ticket", true, "FORBIDDEN");
      }
      return next();
    }

    if (isVendedor(user)) {
      const userSucursalId = getUserSucursalId(user);
      if (
        !userConcessionId ||
        data.concesionId !== userConcessionId ||
        (data.sucursalId && userSucursalId && data.sucursalId !== userSucursalId) ||
        (data.idUser && data.idUser !== user.uid)
      ) {
        throw new ApiError(403, "No tienes acceso a este ticket", true, "FORBIDDEN");
      }
    }

    next();
  },
);

export const requireTicketUpdateAccess = requireTicketAccess;
