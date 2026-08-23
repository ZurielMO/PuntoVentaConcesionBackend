import { Router } from "express";
import { authMiddleware } from "../utils/middlewares";
import {
  requireAdminOrSuperAdmin,
  requireAuthenticated,
  requireCinepolisCashier,
} from "../utils/roles.middlewares";
import {
  validateBody,
  validateQuery,
} from "../middleware/validation.middleware";
import {
  assignCinepolisPointsSchema,
  cinepolisAsignacionesQuerySchema,
  consumeAbonadoBenefitSchema,
} from "../middleware/validators/loyalty.validator";
import * as loyaltyQuery from "../controllers/loyalty/loyalty.query.controller";
import * as loyaltyCommand from "../controllers/loyalty/loyalty.command.controller";

const router = Router();

router.use(authMiddleware);

router.get(
  "/conversion",
  requireAuthenticated,
  loyaltyQuery.getPointsConversion,
);

router.get(
  "/miembros/:memberId",
  requireAuthenticated,
  loyaltyQuery.getClubMember,
);

router.get(
  "/abonados/:memberId",
  requireAuthenticated,
  loyaltyQuery.getAbonado,
);

router.post(
  "/abonados/:memberId/beneficios/:benefitId/consumir",
  requireAuthenticated,
  validateBody(consumeAbonadoBenefitSchema),
  loyaltyCommand.consumeAbonadoBenefit,
);

router.post(
  "/cinepolis/asignar",
  requireCinepolisCashier,
  validateBody(assignCinepolisPointsSchema),
  loyaltyCommand.assignCinepolisPoints,
);

router.get(
  "/cinepolis/asignaciones",
  requireCinepolisCashier,
  validateQuery(cinepolisAsignacionesQuerySchema),
  loyaltyQuery.listCinepolisAsignaciones,
);

router.get(
  "/pendientes",
  requireAdminOrSuperAdmin,
  loyaltyCommand.listPendingLoyalty,
);

router.post(
  "/pendientes/reprocesar",
  requireAdminOrSuperAdmin,
  loyaltyCommand.reprocessPendingLoyalty,
);

export default router;
