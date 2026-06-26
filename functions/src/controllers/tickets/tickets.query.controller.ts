import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as ticketService from "../../services/ticket.service";

export const getTickets = asyncHandler(async (_req: Request, res: Response) => {
  const data = await ticketService.listTickets();
  res.status(200).json({ success: true, data, count: data.length });
});

export const getTicketById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await ticketService.getTicketById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
