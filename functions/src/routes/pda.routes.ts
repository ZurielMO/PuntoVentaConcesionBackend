/**
 * Rutas de las PDAs. Las de operación reutilizan los controladores del POS; solo
 * se exponen las que usa la app, sin ninguna ruta administrativa ni de escritura
 * de catálogo. Las rutas del panel no cambian y no aceptan credenciales de PDA.
 */
import { Router } from "express";
import * as pda from "../controllers/pda/pda.controller";
import * as jornadas from "../controllers/jornadas/jornadas.query.controller";
import * as inventarios from "../controllers/inventarios/inventarios.query.controller";
import * as products from "../controllers/products/products.query.controller";
import * as combos from "../controllers/combos/combos.query.controller";
import * as descuentos from "../controllers/descuentos/descuentos.query.controller";
import * as ventasQuery from "../controllers/detalle-venta/detalle-venta.query.controller";
import * as ventasCommand from "../controllers/detalle-venta/detalle-venta.command.controller";
import * as cortesQuery from "../controllers/cortes/cortes.query.controller";
import * as cortesCommand from "../controllers/cortes/cortes.command.controller";
import * as loyaltyQuery from "../controllers/loyalty/loyalty.query.controller";
import * as loyaltyCommand from "../controllers/loyalty/loyalty.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { vipRateLimit } from "../middleware/vip-rate-limit.middleware";
import {
  approvePdaDeviceSchema,
  createPdaCajaSessionSchema,
  createPdaSessionSchema,
  registerPdaDeviceSchema,
} from "../middleware/validators/pda.validator";
import { createPdaVentaSchema } from "../middleware/validators/detalle-venta.validator";
import { cerrarCorteSchema } from "../middleware/validators/corte.validator";
import {
  assignVentaPointsSchema,
  consumeAbonadoBenefitSchema,
} from "../middleware/validators/loyalty.validator";
import { authMiddleware } from "../utils/middlewares";
import {
  pdaAuthMiddleware,
  requirePdaCaja,
  requirePdaVentaDeCaja,
} from "../utils/pda.middlewares";
import {
  requireDetalleVentaCreateAccess,
  requireSuperAdmin,
} from "../utils/roles.middlewares";

const ONE_MINUTE_MS = 60_000;

const router = Router();

// Sin credencial todavía: solo registrarse como pendiente o pedir sesión.
router.post(
  "/devices/register",
  vipRateLimit("pda_register", 20, ONE_MINUTE_MS),
  validateBody(registerPdaDeviceSchema),
  pda.registerDevice,
);
router.post(
  "/auth/session",
  vipRateLimit("pda_session", 60, ONE_MINUTE_MS),
  validateBody(createPdaSessionSchema),
  pda.createSession,
);

// Autorizar y revocar dispositivos: login de usuario + SuperAdmin.
const admin = Router();
admin.use(authMiddleware, requireSuperAdmin);
admin.get("/devices", pda.listDevices);
admin.post(
  "/devices/:deviceId/approve",
  validateBody(approvePdaDeviceSchema),
  pda.approveDevice,
);
admin.post("/devices/:deviceId/revoke", pda.revokeDevice);
router.use("/admin", admin);

// Dispositivo autorizado: catálogo para elegir caja.
router.use(pdaAuthMiddleware);
router.get("/concesiones", pda.getConcesiones);
router.get("/concesiones/:concesionId/sucursales", pda.getSucursales);
router.get("/sucursales/:sucursalId/cajas", pda.getCajas);
router.post(
  "/caja-session",
  validateBody(createPdaCajaSessionSchema),
  pda.createCajaSession,
);

// Caja seleccionada: operación del POS.
router.use(requirePdaCaja);
router.get("/jornadas/activa", jornadas.getJornadaActiva);
router.get("/inventarios/jornada-activa", inventarios.getInventarioJornadaActiva);
router.get("/products", products.getProducts);
router.get("/combos", combos.getCombos);
router.get("/descuentos", descuentos.getDescuentos);

router.get("/detalle-venta", ventasQuery.getDetalleVentas);
router.post(
  "/detalle-venta/ventas/:ventaId/asignar-puntos",
  validateBody(assignVentaPointsSchema),
  requirePdaVentaDeCaja((req) => req.params.ventaId),
  loyaltyCommand.assignVentaPoints,
);
router.post(
  "/detalle-venta/ventas/:ventaId/concesiones/:concesionId/sucursales/:sucursalId/inventarios/:inventarioId",
  requireDetalleVentaCreateAccess,
  validateBody(createPdaVentaSchema),
  ventasCommand.createDetalleVenta,
);

router.get("/cortes/resumen", cortesQuery.getCorteResumen);
router.post(
  "/cortes/cerrar",
  validateBody(cerrarCorteSchema),
  cortesCommand.cerrarCorte,
);

router.get("/loyalty/miembros/:memberId", loyaltyQuery.getClubMember);
router.get("/loyalty/abonados/:memberId", loyaltyQuery.getAbonado);
router.post(
  "/loyalty/abonados/:memberId/beneficios/:benefitId/consumir",
  validateBody(consumeAbonadoBenefitSchema),
  requirePdaVentaDeCaja((req) => req.body?.ventaId),
  loyaltyCommand.consumeAbonadoBenefit,
);

export default router;
