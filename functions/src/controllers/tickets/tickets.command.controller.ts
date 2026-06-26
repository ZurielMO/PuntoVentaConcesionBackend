import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as ticketService from "../../services/ticket.service";

export const createTicket = asyncHandler(
  async (req: Request, res: Response) => {
    const idUser =
      (req.query.idUser as string | undefined) ?? req.user?.uid ?? undefined;
    const data = await ticketService.createTicket(idUser, req.body);
    res.status(201).json({ success: true, data, message: "Ticket creado" });
  },
);

export const updateTicket = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await ticketService.updateTicket(req.params.id, req.body);
    res
      .status(200)
      .json({ success: true, data, message: "Ticket actualizado" });
  },
);
