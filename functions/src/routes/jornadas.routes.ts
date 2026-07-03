import { Router } from "express";
import * as q from "../controllers/jornadas/jornadas.query.controller";
import * as a from "../controllers/jornadas/asignacion-caja.controller";
import { authMiddleware } from "../utils/middlewares";
import { validateBody } from "../middleware/validation.middleware";
import {
  requireAuthenticated,
  requireSuperAdmin,
} from "../utils/roles.middlewares";
import { upsertAsignacionesCajasSchema } from "../middleware/validators/asignacion-caja.validator";

const router = Router();

router.get("/activa", authMiddleware, q.getJornadaActiva);
router.get(
  "/:jornadaId/asignaciones-cajas",
  authMiddleware,
  requireAuthenticated,
  a.getAsignacionesCajas,
);
router.put(
  "/:jornadaId/asignaciones-cajas",
  authMiddleware,
  requireSuperAdmin,
  validateBody(upsertAsignacionesCajasSchema),
  a.upsertAsignacionesCajas,
);
router.get(
  "/:jornadaId/mi-caja",
  authMiddleware,
  requireAuthenticated,
  a.getMiCajaActiva,
);

export default router;
