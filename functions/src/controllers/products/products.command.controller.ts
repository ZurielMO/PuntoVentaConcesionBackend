import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as productService from "../../services/product.service";
import * as storageService from "../../services/storage.service";
import { ApiError } from "../../utils/api-error";
import { createProductSchema } from "../../middleware/validators/product.validator";

const resolveConcessionId = (req: Request): string => {
  const concessionId =
    (req.params.concesionId as string | undefined) ||
    (req.query.concesion_id as string | undefined) ||
    (req.body?.concesionId as string | undefined) ||
    (req.body?.concesion_id as string | undefined) ||
    (req.user?.concesionId as string | undefined);

  if (!concessionId) {
    throw new ApiError(
      400,
      "Se requiere una concesión para crear el producto",
      true,
      "MISSING_CONCESSION",
    );
  }

  return concessionId;
};

const parseMultipartProductBody = (req: Request) => {
  const activoRaw = req.body.activo;
  const activo =
    activoRaw === undefined ||
    activoRaw === "true" ||
    activoRaw === true ||
    activoRaw === "1";

  return createProductSchema.parse({
    nombre: String(req.body.nombre ?? "").trim(),
    unidad_medida: String(req.body.unidad_medida ?? "Unidad").trim() || "Unidad",
    precio: Number(req.body.precio),
    activo,
    imagenes: [],
  });
};

export const createProduct = asyncHandler(
  async (req: Request, res: Response) => {
    const concessionId = resolveConcessionId(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    const body = req.is("multipart/form-data")
      ? parseMultipartProductBody(req)
      : createProductSchema.parse(req.body);

    let product = await productService.createProduct(concessionId, body);

    if (files.length > 0) {
      const urls = await storageService.uploadProductImages(
        concessionId,
        product.id as string,
        files,
      );
      product = await productService.appendProductImages(product.id as string, urls);
    }

    res.status(201).json({ success: true, data: product, message: "Producto creado" });
  },
);

export const updateProduct = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await productService.updateProduct(req.params.id, req.body);
    res
      .status(200)
      .json({ success: true, data, message: "Producto actualizado" });
  },
);

export const deleteProduct = asyncHandler(
  async (req: Request, res: Response) => {
    await productService.softDeleteProduct(req.params.id);
    res.status(204).send();
  },
);

export const uploadProductImages = asyncHandler(
  async (req: Request, res: Response) => {
    const product = await productService.getProductById(req.params.id);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (files.length === 0) {
      throw new ApiError(400, "No se enviaron imágenes", true, "NO_FILES");
    }

    const concesionId = product.concesion_id as string;
    const existingCount = ((product.imagenes as string[] | undefined) ?? []).length;
    const urls = await storageService.uploadProductImages(
      concesionId,
      req.params.id,
      files,
      existingCount,
    );
    const updated = await productService.appendProductImages(req.params.id, urls);

    res.status(200).json({
      success: true,
      data: updated,
      message: "Imágenes subidas",
    });
  },
);

export const deleteProductImage = asyncHandler(
  async (req: Request, res: Response) => {
    const index = Number(req.params.index);
    if (Number.isNaN(index)) {
      throw new ApiError(400, "Índice de imagen inválido", true, "BAD_REQUEST");
    }

    const { updated, removedUrl } = await productService.removeProductImageAtIndex(
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
