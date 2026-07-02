import { Router } from "express";
import * as q from "../controllers/sucursales/sucursales.query.controller";
import * as c from "../controllers/sucursales/sucursales.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireSucursalReadAccess,
  requireSucursalWriteAccess,
} from "../utils/roles.middlewares";
import {
  createSucursalSchema,
  updateSucursalSchema,
} from "../middleware/validators/sucursal.validator";
import {
  createCajaSchema,
  updateCajaSchema,
} from "../middleware/validators/caja.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", q.getSucursales);
router.post(
  "/",
  requireSucursalWriteAccess,
  validateBody(createSucursalSchema),
  c.createSucursal,
);
router.get("/:id", requireSucursalReadAccess, q.getSucursalById);
router.get("/:id/cajas", requireSucursalReadAccess, q.getCajas);
router.post(
  "/:id/cajas",
  requireSucursalWriteAccess,
  validateBody(createCajaSchema),
  c.createCaja,
);
router.patch(
  "/:id/cajas/:cajaId",
  requireSucursalWriteAccess,
  validateBody(updateCajaSchema),
  c.updateCaja,
);
router.delete("/:id/cajas/:cajaId", requireSucursalWriteAccess, c.deleteCaja);
router.put(
  "/:id",
  requireSucursalWriteAccess,
  validateBody(updateSucursalSchema),
  c.updateSucursal,
);
router.delete("/:id", requireSucursalWriteAccess, c.deleteSucursal);

export default router;
