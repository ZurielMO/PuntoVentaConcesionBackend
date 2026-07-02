import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import { ApiError } from "../../utils/api-error";
import * as ticketService from "../../services/ticket.service";
import {
  getUserConcessionId,
  getUserSucursalId,
} from "../../utils/roles.middlewares";

export const createTicket = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;
    if (!user?.uid) {
      throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
    }

    const concesionId = getUserConcessionId(user);
    if (!concesionId) {
      throw new ApiError(403, "Usuario sin concesión asignada", true, "FORBIDDEN");
    }

    const data = await ticketService.createTicket(
      {
        concesionId,
        sucursalId: getUserSucursalId(user) ?? null,
        idUser: user.uid,
      },
      req.body,
    );
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
