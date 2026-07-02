import { Router } from "express";
import * as q from "../controllers/products/products.query.controller";
import * as c from "../controllers/products/products.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireProductCreateAccess,
  requireProductWriteAccess,
  requireProductReadAccess,
  requireAuthenticated,
} from "../utils/roles.middlewares";
import {
  createProductSchema,
  updateProductSchema,
} from "../middleware/validators/product.validator";
import {
  optionalProductImagesUpload,
  productImagesUpload,
} from "../middleware/upload.middleware";

const router = Router();

router.use(authMiddleware);

router.get("/", requireAuthenticated, q.getProducts);
router.get("/:id", requireProductReadAccess, q.getProductById);

router.post(
  "/",
  requireProductCreateAccess,
  optionalProductImagesUpload,
  (req, res, next) => {
    if (req.is("multipart/form-data")) {
      return next();
    }
    return validateBody(createProductSchema)(req, res, next);
  },
  c.createProduct,
);

router.post(
  "/:id/images",
  requireProductWriteAccess,
  productImagesUpload.array("images", 5),
  c.uploadProductImages,
);

router.delete(
  "/:id/images/:index",
  requireProductWriteAccess,
  c.deleteProductImage,
);

router.put(
  "/:id",
  requireProductWriteAccess,
  validateBody(updateProductSchema),
  c.updateProduct,
);
router.delete("/:id", requireProductWriteAccess, c.deleteProduct);

export default router;
