import { Router } from "express";
import * as q from "../controllers/concessions/concessions.query.controller";
import * as c from "../controllers/concessions/concessions.command.controller";
import * as productQ from "../controllers/products/products.query.controller";
import * as productC from "../controllers/products/products.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware, requireAdmin } from "../utils/middlewares";
import {
  createConcessionSchema,
  replaceConcessionSchema,
  assignConcessionPointsSchema,
} from "../middleware/validators/concession.validator";
import {
  createProductSchema,
} from "../middleware/validators/product.validator";

const router = Router();

router.use(authMiddleware);

// IMPORTANTE: la ruta del typo intencional va ANTES de "/:id" para que
// "/:id" no la capture. También existe un shortcut en app.ts.
router.post(
  "/asignarPuntosConsecion",
  requireAdmin,
  validateBody(assignConcessionPointsSchema),
  c.assignConcessionPoints,
);

// Productos anidados por concesión.
router.get("/:concesionId/products", productQ.getProductsByConcession);
router.post(
  "/:concesionId/products",
  requireAdmin,
  validateBody(createProductSchema),
  productC.createProduct,
);

router.get("/", q.getConcessions);
router.post(
  "/",
  requireAdmin,
  validateBody(createConcessionSchema),
  c.createConcession,
);
router.get("/:id", q.getConcessionById);
router.put(
  "/:id",
  requireAdmin,
  validateBody(replaceConcessionSchema),
  c.replaceConcession,
);
router.delete("/:id", requireAdmin, c.deleteConcession);

export default router;
