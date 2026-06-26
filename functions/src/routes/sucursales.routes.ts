import { Router } from "express";
import * as q from "../controllers/sucursales/sucursales.query.controller";
import * as c from "../controllers/sucursales/sucursales.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware, requireAdmin } from "../utils/middlewares";
import {
  createSucursalSchema,
  updateSucursalSchema,
} from "../middleware/validators/sucursal.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", q.getSucursales);
router.post(
  "/",
  requireAdmin,
  validateBody(createSucursalSchema),
  c.createSucursal,
);
router.get("/:id", q.getSucursalById);
router.get("/:id/cajas", q.getCajas);
router.put(
  "/:id",
  requireAdmin,
  validateBody(updateSucursalSchema),
  c.updateSucursal,
);
router.delete("/:id", requireAdmin, c.deleteSucursal);

export default router;
