import { Router } from "express";
import * as q from "../controllers/users/users.query.controller";
import * as c from "../controllers/users/users.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import { requireSuperAdmin } from "../utils/roles.middlewares";
import {
  createUserSchema,
  updateUserSchema,
} from "../middleware/validators/user.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", requireSuperAdmin, q.getUsers);
router.post(
  "/",
  requireSuperAdmin,
  validateBody(createUserSchema),
  c.createUser,
);
router.get("/:id", requireSuperAdmin, q.getUserById);
router.put(
  "/:id",
  requireSuperAdmin,
  validateBody(updateUserSchema),
  c.updateUser,
);
router.delete("/:id", requireSuperAdmin, c.deleteUser);

export default router;
