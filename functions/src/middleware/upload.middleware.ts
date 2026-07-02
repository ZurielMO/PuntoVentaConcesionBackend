import multer from "multer";
import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/api-error";
import {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
} from "../services/storage.service";

const storage = multer.memoryStorage();

const imageFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (ALLOWED_IMAGE_MIMES.includes(file.mimetype as (typeof ALLOWED_IMAGE_MIMES)[number])) {
    cb(null, true);
    return;
  }
  cb(
    new ApiError(
      400,
      "Formato de imagen no permitido (usa JPEG, PNG o WebP)",
      true,
      "INVALID_MIME",
    ),
  );
};

export const productImagesUpload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_PRODUCT },
  fileFilter: imageFilter,
});

/** Aplica multer solo cuando el request es multipart/form-data. */
export const optionalProductImagesUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.is("multipart/form-data")) {
    return productImagesUpload.array("images", MAX_IMAGES_PER_PRODUCT)(req, res, next);
  }
  return next();
};
