import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

/**
 * Genera un `idOrigen` cifrado (AES-256-CBC) para trazar el origen de la
 * asignación de puntos hacia el backend externo.
 *
 * Payload en claro: `${sistema}:${userId}:${total}:${timestamp}:${uuid}`
 * Clave: SHA-256 del secreto configurado (CONCESSION_POINTS_SOURCE_SECRET).
 * Salida: `${ivHex}.${cipherHex}`
 */
export const buildOriginId = (params: {
  sistema: string;
  userId: string;
  total: number;
}): string => {
  const secret =
    process.env.CONCESSION_POINTS_SOURCE_SECRET ||
    process.env.ORIGIN_ID_SECRET ||
    "";

  const timestamp = Date.now();
  const plain = `${params.sistema}:${params.userId}:${params.total}:${timestamp}:${uuidv4()}`;

  if (!secret) {
    // Sin secreto configurado, devolvemos un identificador no cifrado pero único.
    return Buffer.from(plain).toString("base64url");
  }

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);

  return `${iv.toString("hex")}.${encrypted.toString("hex")}`;
};
