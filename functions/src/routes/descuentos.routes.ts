import { Router } from "express";
import * as q from "../controllers/descuentos/descuentos.query.controller";
import * as c from "../controllers/descuentos/descuentos.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireAuthenticated,
  requireSuperAdmin,
} from "../utils/roles.middlewares";
import {
  createDescuentoSchema,
  updateDescuentoSchema,
} from "../middleware/validators/descuento.validator";

const router = Router();

router.use(authMiddleware);

// Lectura: todos los roles autenticados (scoped por concesión en el controller)
router.get("/", requireAuthenticated, q.getDescuentos);
router.get("/:id", requireAuthenticated, q.getDescuentoById);

// Escritura: exclusiva de SUPERADMIN
router.post(
  "/",
  requireSuperAdmin,
  validateBody(createDescuentoSchema),
  c.createDescuento,
);
router.put(
  "/:id",
  requireSuperAdmin,
  validateBody(updateDescuentoSchema),
  c.updateDescuento,
);
router.delete("/:id", requireSuperAdmin, c.deleteDescuento);
router.delete("/:id/hard", requireSuperAdmin, c.hardDeleteDescuento);

export default router;
