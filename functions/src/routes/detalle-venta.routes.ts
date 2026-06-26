import { Router } from "express";
import * as q from "../controllers/detalle-venta/detalle-venta.query.controller";
import * as c from "../controllers/detalle-venta/detalle-venta.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  createDetalleVentaSchema,
  updateDetalleVentaSchema,
} from "../middleware/validators/detalle-venta.validator";

const router = Router();

router.use(authMiddleware);

router.post(
  "/ventas/:ventaId/concesiones/:concesionId/sucursales/:sucursalId/inventarios/:inventarioId",
  validateBody(createDetalleVentaSchema),
  c.createDetalleVenta,
);
router.get("/:id", q.getDetalleVentaById);
router.put(
  "/:id",
  validateBody(updateDetalleVentaSchema),
  c.updateDetalleVenta,
);

export default router;
