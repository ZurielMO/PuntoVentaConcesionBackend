import { z } from "zod";

const deviceId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, "Identificador de dispositivo inválido");
const deviceSecret = z.string().min(32).max(128);
const docId = z.string().trim().min(1).max(200).regex(/^[^/]+$/);

export const registerPdaDeviceSchema = z
  .object({
    deviceId,
    deviceSecret,
    modelo: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const createPdaSessionSchema = z
  .object({ deviceId, deviceSecret })
  .strict();

export const createPdaCajaSessionSchema = z
  .object({
    concesionId: docId,
    sucursalId: docId,
    cajaId: docId,
  })
  .strict();

export const approvePdaDeviceSchema = z
  .object({ pairingCode: z.string().trim().length(6) })
  .strict();
