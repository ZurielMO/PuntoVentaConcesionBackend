import { Router } from "express";
import * as q from "../controllers/tickets/tickets.query.controller";
import * as c from "../controllers/tickets/tickets.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireAuthenticated,
  requireTicketAccess,
  requireTicketCreateAccess,
  requireTicketUpdateAccess,
} from "../utils/roles.middlewares";
import {
  createTicketSchema,
  updateTicketSchema,
} from "../middleware/validators/ticket.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", requireAuthenticated, q.getTickets);
router.post("/", requireTicketCreateAccess, validateBody(createTicketSchema), c.createTicket);
router.get("/:id", requireTicketAccess, q.getTicketById);
router.put("/:id", requireTicketUpdateAccess, validateBody(updateTicketSchema), c.updateTicket);

export default router;
