import { Router } from "express";
import * as q from "../controllers/users/users.query.controller";
import * as c from "../controllers/users/users.command.controller";
import * as a from "../controllers/users/users.asignacion.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireSuperAdmin,
  requireAdminConcesion,
} from "../utils/roles.middlewares";
import {
  createUserSchema,
  updateUserSchema,
} from "../middleware/validators/user.validator";
import { assignVendedorSchema } from "../middleware/validators/user-asignacion.validator";

const router = Router();

router.use(authMiddleware);

router.get("/equipo", requireAdminConcesion, q.getVendedoresEquipo);
router.get("/", requireSuperAdmin, q.getUsers);
router.post(
  "/",
  requireSuperAdmin,
  validateBody(createUserSchema),
  c.createUser,
);
router.patch(
  "/:id/asignacion",
  requireSuperAdmin,
  validateBody(assignVendedorSchema),
  a.assignVendedor,
);
router.get("/:id", requireSuperAdmin, q.getUserById);
router.put(
  "/:id",
  requireSuperAdmin,
  validateBody(updateUserSchema),
  c.updateUser,
);
router.delete("/:id/hard", requireSuperAdmin, c.hardDeleteUser);
router.delete("/:id", requireSuperAdmin, c.deleteUser);

export default router;
