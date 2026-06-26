import { Router } from "express";
import * as q from "../controllers/cortes/cortes.query.controller";
import * as c from "../controllers/cortes/cortes.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  createCorteSchema,
  updateCorteSchema,
} from "../middleware/validators/corte.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", q.getCortes);
router.post("/", validateBody(createCorteSchema), c.createCorte);
router.get("/:id", q.getCorteById);
router.put("/:id", validateBody(updateCorteSchema), c.updateCorte);

export default router;
