import { randomUUID } from "crypto";
import { storage } from "../config/firebase";
import { ApiError } from "../utils/api-error";

export const ALLOWED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 5;
export const MAX_IMAGES_PER_CONCESSION = 5;

const mimeToExt: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** URL pública vía reglas Storage (allow read) — sin token de descarga. */
export const buildFirebasePublicUrl = (
  bucketName: string,
  objectPath: string,
): string =>
  `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media`;

export const validateImageFile = (file: {
  mimetype: string;
  size: number;
}) => {
  if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype as (typeof ALLOWED_IMAGE_MIMES)[number])) {
    throw new ApiError(
      400,
      "Formato de imagen no permitido (usa JPEG, PNG o WebP)",
      true,
      "INVALID_MIME",
    );
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ApiError(
      400,
      "La imagen supera el límite de 5 MB",
      true,
      "FILE_TOO_LARGE",
    );
  }
};

export const storagePathFromUrl = (url: string): string | null => {
  try {
    const firebaseMatch = url.match(/\/o\/([^?]+)/);
    if (firebaseMatch) {
      return decodeURIComponent(firebaseMatch[1]);
    }
    const gcsMatch = url.match(/storage\.googleapis\.com\/[^/]+\/(.+?)(?:\?|$)/);
    if (gcsMatch) {
      return decodeURIComponent(gcsMatch[1]);
    }
  } catch {
    return null;
  }
  return null;
};

/** Normaliza URLs viejas con token a URL pública (misma ruta y bucket). */
export const normalizeFirebaseImageUrl = (url: string): string => {
  const path = storagePathFromUrl(url);
  if (!path) return url;
  const bucketFromUrl =
    url.match(/\/b\/([^/]+)\//)?.[1] ??
    url.match(/storage\.googleapis\.com\/([^/]+)\//)?.[1];
  const bucketName = bucketFromUrl ?? storage.bucket().name;
  return buildFirebasePublicUrl(bucketName, path);
};

export const uploadImageToPath = async (
  objectPath: string,
  file: Express.Multer.File,
): Promise<string> => {
  validateImageFile(file);

  const bucket = storage.bucket();
  const fileRef = bucket.file(objectPath);

  await fileRef.save(file.buffer, {
    metadata: {
      contentType: file.mimetype,
      cacheControl: "public, max-age=31536000",
    },
  });

  return buildFirebasePublicUrl(bucket.name, objectPath);
};

export const uploadProductImage = async (
  concesionId: string,
  productId: string,
  file: Express.Multer.File,
): Promise<string> => {
  const ext = mimeToExt[file.mimetype] ?? "jpg";
  const objectPath = `products/${concesionId}/${productId}/${randomUUID()}.${ext}`;
  return uploadImageToPath(objectPath, file);
};

export const uploadProductImages = async (
  concesionId: string,
  productId: string,
  files: Express.Multer.File[],
  existingCount = 0,
): Promise<string[]> => {
  if (existingCount + files.length > MAX_IMAGES_PER_PRODUCT) {
    throw new ApiError(
      400,
      `Máximo ${MAX_IMAGES_PER_PRODUCT} imágenes por producto`,
      true,
      "TOO_MANY_IMAGES",
    );
  }

  const urls: string[] = [];
  for (const file of files) {
    urls.push(await uploadProductImage(concesionId, productId, file));
  }
  return urls;
};

export const uploadConcessionImage = async (
  concessionId: string,
  file: Express.Multer.File,
): Promise<string> => {
  const ext = mimeToExt[file.mimetype] ?? "jpg";
  const objectPath = `concessions/${concessionId}/${randomUUID()}.${ext}`;
  return uploadImageToPath(objectPath, file);
};

export const uploadConcessionImages = async (
  concessionId: string,
  files: Express.Multer.File[],
  existingCount = 0,
): Promise<string[]> => {
  if (existingCount + files.length > MAX_IMAGES_PER_CONCESSION) {
    throw new ApiError(
      400,
      `Máximo ${MAX_IMAGES_PER_CONCESSION} imágenes por concesión`,
      true,
      "TOO_MANY_IMAGES",
    );
  }

  const urls: string[] = [];
  for (const file of files) {
    urls.push(await uploadConcessionImage(concessionId, file));
  }
  return urls;
};

export const deleteStorageFileByUrl = async (url: string) => {
  const path = storagePathFromUrl(url);
  if (!path) return;
  try {
    await storage.bucket().file(path).delete({ ignoreNotFound: true });
  } catch {
    // Ignorar errores de borrado huérfano
  }
};

export const normalizeRecordImageUrls = (
  record: Record<string, unknown> & { id: string },
): Record<string, unknown> & { id: string } => {
  const imagenes = record.imagenes;
  if (!Array.isArray(imagenes)) return record;
  return {
    ...record,
    imagenes: imagenes.map((url) =>
      typeof url === "string" ? normalizeFirebaseImageUrl(url) : url,
    ),
  };
};
