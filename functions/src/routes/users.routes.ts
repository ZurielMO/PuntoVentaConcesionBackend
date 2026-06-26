import { Router } from "express";
import * as q from "../controllers/users/users.query.controller";
import * as c from "../controllers/users/users.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import {
  authMiddleware,
  requireAdmin,
  requireSuperAdmin,
} from "../utils/middlewares";
import {
  createUserSchema,
  updateUserSchema,
} from "../middleware/validators/user.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", requireAdmin, q.getUsers);
router.post(
  "/",
  requireSuperAdmin,
  validateBody(createUserSchema),
  c.createUser,
);
router.get("/:id", requireAdmin, q.getUserById);
router.put("/:id", requireAdmin, validateBody(updateUserSchema), c.updateUser);
router.delete("/:id", requireAdmin, c.deleteUser);

export default router;
