import { Router } from "express";
import * as q from "../controllers/zonas/zonas.query.controller";
import * as c from "../controllers/zonas/zonas.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import { requireAuthenticated, requireSuperAdmin } from "../utils/roles.middlewares";
import {
  createZonaSchema,
  updateZonaSchema,
} from "../middleware/validators/zona.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", requireAuthenticated, q.getZonas);
router.post("/", requireSuperAdmin, validateBody(createZonaSchema), c.createZona);
router.get("/:id", requireAuthenticated, q.getZonaById);
router.put("/:id", requireSuperAdmin, validateBody(updateZonaSchema), c.updateZona);
router.delete("/:id", requireSuperAdmin, c.deleteZona);

export default router;
