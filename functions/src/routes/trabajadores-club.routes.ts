import { Router } from "express";
import * as q from "../controllers/trabajadores-club/trabajadores-club.query.controller";
import * as c from "../controllers/trabajadores-club/trabajadores-club.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import { requireSuperAdmin } from "../utils/roles.middlewares";
import {
  addTrabajadorClubSchema,
  updateCortesiaSchema,
} from "../middleware/validators/trabajador-club.validator";

const router = Router();

router.use(authMiddleware);
router.use(requireSuperAdmin);

router.get("/search", q.searchTrabajadorCandidate);
router.get("/", q.listTrabajadoresClub);
router.post("/", validateBody(addTrabajadorClubSchema), c.addTrabajadorClub);
router.patch(
  "/:uid",
  validateBody(updateCortesiaSchema),
  c.updateCortesiaCanjeada,
);
router.delete("/:uid", c.removeTrabajadorClub);

export default router;
