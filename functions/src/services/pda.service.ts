/**
 * ACCESO DE PDAs
 * ---------------------------------------------------------------------
 * Identidad de dispositivo, independiente del login de usuarios del panel:
 *
 * 1. La PDA genera su propio `deviceId` + `deviceSecret` y se registra como
 *    PENDING. El APK no incluye ningún secreto.
 * 2. Un SuperAdmin autoriza el dispositivo con el código que muestra en pantalla.
 * 3. La PDA obtiene un token de dispositivo, que solo sirve para consultar el
 *    catálogo concesión → sucursal → caja.
 * 4. Al elegir caja, el servidor valida la relación y emite un token de caja,
 *    que es el único que da acceso a la operación del POS.
 *
 * Los tokens se firman con PDA_JWT_SECRET (distinto de JWT_SECRET) y audiencia
 * propia, así que `authMiddleware` los rechaza y viceversa.
 */
import { createHash, randomInt, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { getConcessionById, listConcessions } from "./concession.service";
import {
  assertCajaBelongsToSucursal,
  getCajas,
  getSucursalById,
  listSucursales,
} from "./sucursal.service";

const PDA_AUDIENCE = "pos-pda";
const PDA_ISSUER = "puntoventa-pda";
const DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 6;

export type PdaDeviceStatus = "PENDING" | "ACTIVE" | "REVOKED";

export type PdaCajaScope = {
  concesionId: string;
  sucursalId: string;
  cajaId: string;
};

export type PdaTokenClaims = Partial<PdaCajaScope> & {
  sub: string;
  typ: "pda";
};

const devicesCol = () => firestorePos.collection(COLLECTIONS.PDA_DEVICES);

const hashSecret = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

const secretMatches = (secret: string, expectedHash: unknown): boolean => {
  if (typeof expectedHash !== "string") return false;
  const actual = Buffer.from(hashSecret(secret));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const generatePairingCode = (): string =>
  Array.from(
    { length: PAIRING_CODE_LENGTH },
    () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)],
  ).join("");

const getPdaJwtSecret = (): string => {
  const secret = process.env.PDA_JWT_SECRET?.trim();
  // Un secreto compartido con JWT_SECRET borraría la separación con el panel.
  if (!secret || secret === process.env.JWT_SECRET?.trim()) {
    throw new ApiError(
      503,
      "El acceso de PDAs no está configurado en el servidor",
      false,
      "PDA_NOT_CONFIGURED",
    );
  }
  return secret;
};

const tokenTtlSeconds = (): number => {
  const parsed = Number(process.env.PDA_TOKEN_TTL_SECONDS);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TOKEN_TTL_SECONDS;
};

const signPdaToken = (deviceId: string, scope?: PdaCajaScope) => {
  const expiresIn = tokenTtlSeconds();
  const token = jwt.sign({ typ: "pda", ...scope }, getPdaJwtSecret(), {
    subject: deviceId,
    audience: PDA_AUDIENCE,
    issuer: PDA_ISSUER,
    algorithm: "HS256",
    expiresIn,
  });
  return { token, expiresIn };
};

export const verifyPdaToken = (token: string): PdaTokenClaims => {
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(token, getPdaJwtSecret(), {
      audience: PDA_AUDIENCE,
      issuer: PDA_ISSUER,
      algorithms: ["HS256"],
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, "Sesión de PDA expirada", true, "PDA_TOKEN_EXPIRED");
    }
    throw new ApiError(401, "Credencial de PDA inválida", true, "PDA_TOKEN_INVALID");
  }

  if (typeof decoded === "string" || decoded.typ !== "pda" || !decoded.sub) {
    throw new ApiError(401, "Credencial de PDA inválida", true, "PDA_TOKEN_INVALID");
  }
  return decoded as PdaTokenClaims;
};

const assertDeviceActive = (data: FirebaseFirestore.DocumentData | undefined) => {
  if (data?.status === "REVOKED") {
    throw new ApiError(403, "Este dispositivo fue revocado", true, "PDA_DEVICE_REVOKED");
  }
  if (data?.status !== "ACTIVE") {
    throw new ApiError(
      403,
      "Este dispositivo aún no está autorizado",
      true,
      "PDA_DEVICE_PENDING",
    );
  }
};

/** Revocar surte efecto de inmediato: se consulta en cada petición. */
export const assertActiveDevice = async (deviceId: string) => {
  const doc = await devicesCol().doc(deviceId).get();
  if (!doc.exists) {
    throw new ApiError(401, "Credencial de PDA inválida", true, "PDA_TOKEN_INVALID");
  }
  const data = doc.data();
  assertDeviceActive(data);
  return { pairingCode: String(data?.pairingCode ?? "") };
};

const publicDevice = (
  id: string,
  data: FirebaseFirestore.DocumentData | undefined,
) => ({
  deviceId: id,
  status: data?.status as PdaDeviceStatus,
  pairingCode: data?.pairingCode as string,
  modelo: (data?.modelo as string | null | undefined) ?? null,
  createdAt: data?.createdAt ?? null,
  approvedAt: data?.approvedAt ?? null,
  revokedAt: data?.revokedAt ?? null,
  lastSeenAt: data?.lastSeenAt ?? null,
});

/** Idempotente para el mismo dispositivo; el secreto impide suplantar un id ajeno. */
export const registerDevice = async (input: {
  deviceId: string;
  deviceSecret: string;
  modelo?: string;
}) => {
  const ref = devicesCol().doc(input.deviceId);
  return firestorePos.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      if (!secretMatches(input.deviceSecret, data?.secretHash)) {
        throw new ApiError(
          409,
          "Identificador de dispositivo en uso",
          true,
          "PDA_DEVICE_CONFLICT",
        );
      }
      return {
        deviceId: input.deviceId,
        status: data?.status as PdaDeviceStatus,
        pairingCode: data?.pairingCode as string,
      };
    }

    const pairingCode = generatePairingCode();
    tx.set(ref, {
      status: "PENDING",
      secretHash: hashSecret(input.deviceSecret),
      pairingCode,
      modelo: input.modelo ?? null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      deviceId: input.deviceId,
      status: "PENDING" as PdaDeviceStatus,
      pairingCode,
    };
  });
};

export const createDeviceSession = async (input: {
  deviceId: string;
  deviceSecret: string;
}) => {
  const ref = devicesCol().doc(input.deviceId);
  const snap = await ref.get();
  const data = snap.data();
  if (!snap.exists || !secretMatches(input.deviceSecret, data?.secretHash)) {
    throw new ApiError(
      401,
      "Credencial de PDA inválida",
      true,
      "PDA_INVALID_CREDENTIALS",
    );
  }
  assertDeviceActive(data);

  const session = signPdaToken(input.deviceId);
  await ref.update({ lastSeenAt: FieldValue.serverTimestamp() });
  return session;
};

export const listPdaConcesiones = async () => {
  const concesiones = await listConcessions();
  return concesiones
    .map((c) => c as unknown as Record<string, unknown> & { id: string })
    .filter((c) => c.activo !== false)
    .map((c) => ({
      id: c.id,
      nombre: (c.nombre as string | undefined) ?? null,
      activo: true,
    }));
};

const isPosSucursal = (sucursal: Record<string, unknown>): boolean =>
  sucursal.activo !== false && sucursal.modo_operacion !== "CONTEO";

export const listPdaSucursales = async (concesionId: string) => {
  const sucursales = await listSucursales(concesionId);
  return sucursales
    .map((s) => s as unknown as Record<string, unknown> & { id: string })
    .filter(isPosSucursal)
    .map((s) => ({
      id: s.id,
      nombre: (s.nombre as string | null | undefined) ?? null,
      concesion_id: s.concesion_id as string,
      activo: true,
    }));
};

const assertPosSucursal = (sucursal: Record<string, unknown>) => {
  if (!isPosSucursal(sucursal)) {
    throw new ApiError(
      409,
      "La sucursal no está disponible para el punto de venta",
      true,
      "PDA_CAJA_INVALID",
    );
  }
};

export const listPdaCajas = async (sucursalId: string) => {
  assertPosSucursal(
    (await getSucursalById(sucursalId)) as unknown as Record<string, unknown>,
  );
  const cajas = await getCajas(sucursalId);
  return cajas.map((c) => {
    const caja = c as unknown as Record<string, unknown> & { id: string };
    return {
      id: caja.id,
      nombre: caja.nombre as string,
      activo: true,
      orden: Number(caja.orden ?? 0),
    };
  });
};

/**
 * Valida concesión → sucursal → caja contra la base de datos. Se ejecuta al
 * abrir la sesión de caja y en cada petición operativa: desactivar una caja
 * corta su operación aunque el token siga vigente.
 */
export const resolveCajaScope = async (scope: PdaCajaScope) => {
  const invalid = () =>
    new ApiError(
      409,
      "La caja seleccionada ya no está disponible",
      true,
      "PDA_CAJA_INVALID",
    );

  let concesion: Record<string, unknown>;
  let sucursal: Record<string, unknown>;
  let caja: Record<string, unknown>;
  try {
    [concesion, sucursal, caja] = (await Promise.all([
      getConcessionById(scope.concesionId),
      getSucursalById(scope.sucursalId),
      assertCajaBelongsToSucursal(scope.sucursalId, scope.cajaId),
    ])) as unknown as Record<string, unknown>[];
  } catch (error) {
    if (error instanceof ApiError && error.statusCode < 500) throw invalid();
    throw error;
  }

  if (concesion.activo === false || sucursal.concesion_id !== scope.concesionId) {
    throw invalid();
  }
  assertPosSucursal(sucursal);

  return {
    ...scope,
    concesionNombre: (concesion.nombre as string | undefined) ?? null,
    sucursalNombre: (sucursal.nombre as string | null | undefined) ?? null,
    cajaNombre: String(caja.nombre ?? scope.cajaId),
  };
};

export const createCajaSession = async (
  deviceId: string,
  scope: PdaCajaScope,
) => {
  const resolved = await resolveCajaScope(scope);
  return {
    ...signPdaToken(deviceId, scope),
    ...resolved,
  };
};

export const listDevices = async () => {
  const snap = await devicesCol().get();
  return snap.docs.map((doc) => publicDevice(doc.id, doc.data()));
};

/** Exige el código en pantalla para no autorizar por error otro dispositivo. */
export const approveDevice = async (deviceId: string, pairingCode: string) => {
  const ref = devicesCol().doc(deviceId);
  return firestorePos.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new ApiError(404, "Dispositivo no encontrado", true, "NOT_FOUND");
    }
    const data = snap.data();
    if (data?.pairingCode !== pairingCode) {
      throw new ApiError(
        400,
        "El código no corresponde al dispositivo",
        true,
        "PDA_PAIRING_MISMATCH",
      );
    }
    tx.update(ref, {
      status: "ACTIVE",
      approvedAt: FieldValue.serverTimestamp(),
      revokedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return publicDevice(deviceId, { ...data, status: "ACTIVE" });
  });
};

export const revokeDevice = async (deviceId: string) => {
  const ref = devicesCol().doc(deviceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new ApiError(404, "Dispositivo no encontrado", true, "NOT_FOUND");
  }
  await ref.update({
    status: "REVOKED",
    revokedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return publicDevice(deviceId, { ...snap.data(), status: "REVOKED" });
};
