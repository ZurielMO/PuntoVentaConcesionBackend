import { Router } from "express";
import * as q from "../controllers/combos/combos.query.controller";
import * as c from "../controllers/combos/combos.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireAuthenticated,
  requireSuperAdmin,
} from "../utils/roles.middlewares";
import {
  createComboSchema,
  updateComboSchema,
} from "../middleware/validators/combo.validator";

const router = Router();

router.use(authMiddleware);

// Lectura: todos los roles autenticados (scoped por concesión en el controller)
router.get("/", requireAuthenticated, q.getCombos);
router.get("/:id", requireAuthenticated, q.getComboById);

// Escritura: exclusiva de SUPERADMIN
router.post("/", requireSuperAdmin, validateBody(createComboSchema), c.createCombo);
router.put(
  "/:id",
  requireSuperAdmin,
  validateBody(updateComboSchema),
  c.updateCombo,
);
router.delete("/:id", requireSuperAdmin, c.deleteCombo);
router.delete("/:id/hard", requireSuperAdmin, c.hardDeleteCombo);

export default router;
