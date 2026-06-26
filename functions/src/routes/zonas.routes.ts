import { Router } from "express";
import * as q from "../controllers/zonas/zonas.query.controller";
import * as c from "../controllers/zonas/zonas.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware, requireAdmin } from "../utils/middlewares";
import {
  createZonaSchema,
  updateZonaSchema,
} from "../middleware/validators/zona.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", q.getZonas);
router.post("/", requireAdmin, validateBody(createZonaSchema), c.createZona);
router.get("/:id", q.getZonaById);
router.put("/:id", requireAdmin, validateBody(updateZonaSchema), c.updateZona);
router.delete("/:id", requireAdmin, c.deleteZona);

export default router;
