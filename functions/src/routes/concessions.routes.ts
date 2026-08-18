// routes/concessions.routes.ts
import { Router } from "express";
import * as q from "../controllers/concessions/concessions.query.controller";
import * as c from "../controllers/concessions/concessions.command.controller";
import * as productQ from "../controllers/products/products.query.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  createConcessionSchema,
  replaceConcessionSchema,
  assignConcessionPointsSchema,
  assignUserToConcessionSchema,
  updateConcessionComisionSchema,
} from "../middleware/validators/concession.validator";
import { requireSuperAdmin } from "../utils/roles.middlewares";
import { productImagesUpload } from "../middleware/upload.middleware";

const router = Router();

router.use(authMiddleware);

// Rutas estáticas antes de /:id
router.post(
  "/asignarPuntosConsecion",
  requireSuperAdmin,
  validateBody(assignConcessionPointsSchema),
  c.assignConcessionPoints,
);

router.get("/", requireSuperAdmin, q.getConcessions);
router.post(
  "/",
  requireSuperAdmin,
  validateBody(createConcessionSchema),
  c.createConcession,
);

router.get("/:id", requireSuperAdmin, q.getConcessionById);
router.put(
  "/:id",
  requireSuperAdmin,
  validateBody(replaceConcessionSchema),
  c.replaceConcession,
);
router.delete("/:id", requireSuperAdmin, c.deleteConcession);

router.put(
  "/:id/assign-user",
  requireSuperAdmin,
  validateBody(assignUserToConcessionSchema),
  c.assignUserToConcession,
);

router.patch(
  "/:id/comision",
  requireSuperAdmin,
  validateBody(updateConcessionComisionSchema),
  c.updateConcessionComision,
);

router.post(
  "/:id/images",
  requireSuperAdmin,
  productImagesUpload.array("images", 5),
  c.uploadConcessionImages,
);

router.delete(
  "/:id/images/:index",
  requireSuperAdmin,
  c.deleteConcessionImage,
);

router.get(
  "/:concesionId/products",
  requireSuperAdmin,
  productQ.getProductsByConcession,
);

export default router;
