import { NextFunction, Request, Response } from "express";
import { ApiError } from "./api-error";
import { asyncHandler } from "./error-handler";
import { UserRole } from "../models";
import * as pdaService from "../services/pda.service";
import * as detalleVentaService from "../services/detalle-venta.service";

/**
 * Autentica una PDA con su token propio. Es independiente de `authMiddleware`:
 * no acepta JWT de usuarios ni deja `req.user`, que solo existe en las rutas
 * operativas tras `requirePdaCaja`.
 */
export const pdaAuthMiddleware = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new ApiError(
        401,
        "Falta la credencial de la PDA",
        true,
        "PDA_UNAUTHENTICATED",
      );
    }

    const claims = pdaService.verifyPdaToken(header.slice("Bearer ".length).trim());
    const device = await pdaService.assertActiveDevice(claims.sub);

    req.pda = {
      deviceId: claims.sub,
      pairingCode: device.pairingCode,
      concesionId: claims.concesionId,
      sucursalId: claims.sucursalId,
      cajaId: claims.cajaId,
    };
    next();
  },
);

/**
 * Exige un token de caja, revalida la relación y expone el contexto a los
 * controladores existentes con el mínimo alcance (rol VENDEDOR, una sola
 * sucursal y caja). Los filtros salen del token: lo que el cliente mande en
 * la query para sucursal o caja se sobrescribe.
 */
export const requirePdaCaja = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const pda = req.pda;
    if (!pda?.concesionId || !pda.sucursalId || !pda.cajaId) {
      throw new ApiError(
        403,
        "Selecciona una caja para operar",
        true,
        "PDA_CAJA_REQUIRED",
      );
    }

    const caja = await pdaService.resolveCajaScope({
      concesionId: pda.concesionId,
      sucursalId: pda.sucursalId,
      cajaId: pda.cajaId,
    });
    pda.cajaNombre = caja.cajaNombre;

    req.user = {
      uid: `pda:${pda.deviceId}`,
      rol: UserRole.VENDEDOR,
      nombre: `PDA ${pda.pairingCode}`,
      activo: true,
      admin: false,
      isAdmin: false,
      from_concesion: true,
      concesionId: pda.concesionId,
      sucursalId: pda.sucursalId,
      cajaId: pda.cajaId,
    };
    req.query = {
      ...req.query,
      concesionId: pda.concesionId,
      sucursalId: pda.sucursalId,
      cajaId: pda.cajaId,
    };
    next();
  },
);

/** Las operaciones sobre una venta ya registrada exigen que sea de esta caja. */
export const requirePdaVentaDeCaja = (ventaIdFrom: (req: Request) => unknown) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const ventaId = String(ventaIdFrom(req) ?? "");
    const comprobante = await detalleVentaService.findComprobanteByVentaId(ventaId);
    if (!comprobante || comprobante.cajaId !== req.pda?.cajaId) {
      throw new ApiError(403, "La venta no pertenece a esta caja", true, "FORBIDDEN");
    }
    next();
  });
