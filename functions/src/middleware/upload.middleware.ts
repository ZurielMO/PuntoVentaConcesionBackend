import Busboy from "busboy";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { ApiError } from "../utils/api-error";
import {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
} from "../services/storage.service";

type AllowedMime = (typeof ALLOWED_IMAGE_MIMES)[number];

function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime);
}

function toMulterFile(
  fieldname: string,
  filename: string,
  encoding: string,
  mimetype: string,
  buffer: Buffer,
): Express.Multer.File {
  return {
    fieldname,
    originalname: filename || "image",
    encoding,
    mimetype,
    size: buffer.length,
    buffer,
    destination: "",
    filename: filename || "image",
    path: "",
    stream: undefined as unknown as Express.Multer.File["stream"],
  };
}

async function readMultipartBuffer(req: Request): Promise<Buffer> {
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) {
    return req.rawBody;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Parse multipart/form-data for image uploads.
 * Cloud Functions buffers the body into `req.rawBody` and leaves the HTTP
 * stream empty — feeding busboy from that buffer avoids "Unexpected end of form".
 * Local Express has no rawBody; we read the request stream into a buffer first.
 */
function parseImagesMultipart(
  fieldName: string,
  maxFiles: number,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const contentType = req.headers["content-type"];
    if (!contentType || !contentType.includes("multipart/form-data")) {
      next(
        new ApiError(
          400,
          "Se esperaba multipart/form-data",
          true,
          "INVALID_CONTENT_TYPE",
        ),
      );
      return;
    }

    void (async () => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        next(err instanceof Error ? err : new Error(String(err)));
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        next();
      };

      let body: Buffer;
      try {
        body = await readMultipartBuffer(req);
      } catch (err) {
        fail(normalizeMultipartParseError(err));
        return;
      }

      if (body.length === 0) {
        fail(
          new ApiError(
            400,
            "La subida de la imagen se interrumpió. Intenta de nuevo.",
            true,
            "MULTIPART_INCOMPLETE",
          ),
        );
        return;
      }

      const files: Express.Multer.File[] = [];
      const fields: Record<string, string> = {};
      let fileCount = 0;
      let pendingFiles = 0;
      let busboyFinished = false;

      const maybeDone = () => {
        if (!busboyFinished || pendingFiles > 0) return;
        req.files = files;
        req.body = { ...(req.body ?? {}), ...fields };
        succeed();
      };

      let busboy: Busboy.Busboy;
      try {
        busboy = Busboy({
          headers: req.headers,
          limits: {
            fileSize: MAX_IMAGE_BYTES,
            files: maxFiles,
          },
        });
      } catch {
        fail(
          new ApiError(
            400,
            "Cabeceras multipart inválidas",
            true,
            "INVALID_MULTIPART",
          ),
        );
        return;
      }

      busboy.on("file", (name, file, info) => {
        const { filename, encoding, mimeType } = info;

        if (name !== fieldName) {
          file.resume();
          return;
        }

        fileCount += 1;
        if (fileCount > maxFiles) {
          file.resume();
          fail(
            new ApiError(
              400,
              `Máximo ${maxFiles} imágenes por solicitud`,
              true,
              "TOO_MANY_IMAGES",
            ),
          );
          return;
        }

        if (!isAllowedMime(mimeType)) {
          file.resume();
          fail(
            new ApiError(
              400,
              "Formato de imagen no permitido (usa JPEG, PNG o WebP)",
              true,
              "INVALID_MIME",
            ),
          );
          return;
        }

        pendingFiles += 1;
        const chunks: Buffer[] = [];
        let truncated = false;

        file.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        file.on("limit", () => {
          truncated = true;
        });

        file.on("error", (err) => {
          pendingFiles -= 1;
          fail(err);
        });

        file.on("end", () => {
          pendingFiles -= 1;
          if (truncated) {
            fail(
              new ApiError(
                400,
                "La imagen supera el límite de 5 MB",
                true,
                "FILE_TOO_LARGE",
              ),
            );
            return;
          }
          const buffer = Buffer.concat(chunks);
          files.push(
            toMulterFile(name, filename, encoding, mimeType, buffer),
          );
          maybeDone();
        });
      });

      busboy.on("field", (name, value) => {
        fields[name] = value;
      });

      busboy.on("filesLimit", () => {
        fail(
          new ApiError(
            400,
            `Máximo ${maxFiles} imágenes por solicitud`,
            true,
            "TOO_MANY_IMAGES",
          ),
        );
      });

      busboy.on("error", (err: Error) => {
        fail(normalizeMultipartParseError(err));
      });

      busboy.on("finish", () => {
        busboyFinished = true;
        maybeDone();
      });

      busboy.end(body);
    })();
  };
}

/** Maps busboy/stream parse failures to operational ApiErrors. */
export function normalizeMultipartParseError(err: unknown): Error {
  if (err instanceof ApiError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : undefined;

  if (code === "LIMIT_FILE_SIZE" || /file too large/i.test(message)) {
    return new ApiError(
      400,
      "La imagen supera el límite de 5 MB",
      true,
      "FILE_TOO_LARGE",
    );
  }

  if (code === "LIMIT_FILE_COUNT" || /too many files/i.test(message)) {
    return new ApiError(
      400,
      "Demasiadas imágenes en la solicitud",
      true,
      "TOO_MANY_IMAGES",
    );
  }

  if (/Unexpected end of form/i.test(message)) {
    return new ApiError(
      400,
      "La subida de la imagen se interrumpió. Intenta de nuevo.",
      true,
      "MULTIPART_INCOMPLETE",
    );
  }

  if (/Unexpected end of multipart data/i.test(message)) {
    return new ApiError(
      400,
      "Formulario multipart incompleto. Intenta de nuevo.",
      true,
      "MULTIPART_INCOMPLETE",
    );
  }

  if (err instanceof Error) return err;
  return new Error(message);
}

/**
 * Drop-in replacement for multer().array(...) that works on Cloud Functions
 * (rawBody) and local Express (req stream).
 */
export const productImagesUpload = {
  array(fieldName: string, maxCount = MAX_IMAGES_PER_PRODUCT): RequestHandler {
    return parseImagesMultipart(fieldName, maxCount);
  },
};

/** Aplica el parser solo cuando el request es multipart/form-data. */
export const optionalProductImagesUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.is("multipart/form-data")) {
    return productImagesUpload.array("images", MAX_IMAGES_PER_PRODUCT)(
      req,
      res,
      next,
    );
  }
  return next();
};
