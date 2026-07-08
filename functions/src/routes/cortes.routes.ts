// routes/cortes.routes.ts
import { Router } from "express";
import * as q from "../controllers/cortes/cortes.query.controller";
import * as c from "../controllers/cortes/cortes.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  createCorteSchema,
  updateCorteSchema,
  cerrarCorteSchema,
} from "../middleware/validators/corte.validator";
import {
  requireAuthenticated,
  requireCorteCreateAccess,
  requireCorteAccess,
  requireCorteUpdateAccess,
} from "../utils/roles.middlewares";

const router = Router();

router.use(authMiddleware);

router.get("/resumen", requireAuthenticated, q.getCorteResumen);
router.post(
  "/cerrar",
  requireCorteCreateAccess,
  validateBody(cerrarCorteSchema),
  c.cerrarCorte,
);
router.get("/", requireAuthenticated, q.getCortes);
router.post("/", requireCorteCreateAccess, validateBody(createCorteSchema), c.createCorte);
router.get("/:id", requireCorteAccess, q.getCorteById);
router.put("/:id", requireCorteUpdateAccess, validateBody(updateCorteSchema), c.updateCorte);

export default router;
