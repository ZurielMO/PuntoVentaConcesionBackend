import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as concessionService from "../../services/concession.service";

export const createConcession = asyncHandler(
  async (req: Request, res: Response) => {
    const idUser =
      (req.query.idUser as string | undefined) ?? req.user?.uid ?? undefined;
    const data = await concessionService.createConcession(req.body, idUser);
    res
      .status(201)
      .json({ success: true, data, message: "Concesión creada" });
  },
);

export const replaceConcession = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await concessionService.replaceConcession(
      req.params.id,
      req.body,
    );
    res
      .status(200)
      .json({ success: true, data, message: "Concesión actualizada" });
  },
);

export const deleteConcession = asyncHandler(
  async (req: Request, res: Response) => {
    await concessionService.softDeleteConcession(req.params.id);
    res.status(204).send();
  },
);

/** Normaliza el body de asignación de puntos (idUser -> userId). */
const normalizeAssignConcessionPointsBody = (body: {
  idUser: string;
  total: number;
  descripcion: string;
}) => ({
  userId: body.idUser,
  total: body.total,
  descripcion: body.descripcion,
});

export const assignConcessionPoints = asyncHandler(
  async (req: Request, res: Response) => {
    const payload = normalizeAssignConcessionPointsBody(req.body);
    const result = await concessionService.assignConcessionPoints(payload);
    res.status(200).json({ success: true, data: result });
  },
);
