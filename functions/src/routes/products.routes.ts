import { Router } from "express";
import * as q from "../controllers/products/products.query.controller";
import * as c from "../controllers/products/products.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware, requireAdmin } from "../utils/middlewares";
import { updateProductSchema } from "../middleware/validators/product.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", q.getProducts);
router.get("/:id", q.getProductById);
router.put(
  "/:id",
  requireAdmin,
  validateBody(updateProductSchema),
  c.updateProduct,
);
router.delete("/:id", requireAdmin, c.deleteProduct);

export default router;
