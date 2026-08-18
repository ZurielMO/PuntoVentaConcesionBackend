import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as concessionService from "../../services/concession.service";
import * as storageService from "../../services/storage.service";
import { ApiError } from "../../utils/api-error";

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

export const assignUserToConcession = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await concessionService.assignUserToConcession(
      req.params.id,
      req.body.userId,
    );
    res.status(200).json({
      success: true,
      data,
      message: "Usuario asignado a concesión correctamente",
    });
  },
);

export const assignConcessionPoints = asyncHandler(
  async (req: Request, res: Response) => {
    const payload = normalizeAssignConcessionPointsBody(req.body);
    const result = await concessionService.assignConcessionPoints(payload);
    res.status(200).json({ success: true, data: result });
  },
);

export const updateConcessionComision = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await concessionService.updateConcessionComision(
      req.params.id,
      req.body.porcentajeComision,
    );
    res.status(200).json({
      success: true,
      data,
      message: "Comisión actualizada",
    });
  },
);

export const uploadConcessionImages = asyncHandler(
  async (req: Request, res: Response) => {
    await concessionService.getConcessionById(req.params.id);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (files.length === 0) {
      throw new ApiError(400, "No se enviaron imágenes", true, "NO_FILES");
    }

    // Logo único: reemplaza (no append) para no dejar URLs rotas al frente.
    const urls = await storageService.uploadConcessionImages(
      req.params.id,
      files,
      0,
    );
    const { updated, previousUrls } =
      await concessionService.replaceConcessionImages(req.params.id, urls);

    await Promise.all(
      previousUrls.map((url) => storageService.deleteStorageFileByUrl(url)),
    );

    res.status(200).json({
      success: true,
      data: updated,
      message: "Imágenes subidas",
    });
  },
);

export const deleteConcessionImage = asyncHandler(
  async (req: Request, res: Response) => {
    const index = Number(req.params.index);
    if (Number.isNaN(index)) {
      throw new ApiError(400, "Índice de imagen inválido", true, "BAD_REQUEST");
    }

    const { updated, removedUrl } = await concessionService.removeConcessionImageAtIndex(
      req.params.id,
      index,
    );
    await storageService.deleteStorageFileByUrl(removedUrl);

    res.status(200).json({
      success: true,
      data: updated,
      message: "Imagen eliminada",
    });
  },
);
