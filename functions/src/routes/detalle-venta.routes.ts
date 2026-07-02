import { Router } from "express";
import * as q from "../controllers/detalle-venta/detalle-venta.query.controller";
import * as c from "../controllers/detalle-venta/detalle-venta.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireDetalleVentaCreateAccess,
  requireDetalleVentaAccess,
  requireAdminOrSuperAdmin,
  requireAuthenticated,
} from "../utils/roles.middlewares";
import {
  createDetalleVentaSchema,
  updateDetalleVentaSchema,
} from "../middleware/validators/detalle-venta.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", requireAuthenticated, q.getDetalleVentas);
router.post(
  "/ventas/:ventaId/concesiones/:concesionId/sucursales/:sucursalId/inventarios/:inventarioId",
  requireDetalleVentaCreateAccess,
  validateBody(createDetalleVentaSchema),
  c.createDetalleVenta,
);
router.get("/:id", requireDetalleVentaAccess, q.getDetalleVentaById);
router.put(
  "/:id",
  requireAdminOrSuperAdmin,
  requireDetalleVentaAccess,
  validateBody(updateDetalleVentaSchema),
  c.updateDetalleVenta,
);

export default router;
