import { Router } from "express";
import { authMiddleware } from "../utils/middlewares";
import {
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

export default router;
