import { Router } from "express";
import * as authController from "../controllers/auth/auth.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  loginSchema,
  loginPasswordSchema,
} from "../middleware/validators/auth.validator";

const router = Router();

router.post("/login", validateBody(loginSchema), authController.login);
router.post(
  "/login/password",
  validateBody(loginPasswordSchema),
  authController.loginWithPassword,
);
router.get("/me", authMiddleware, authController.me);

export default router;
