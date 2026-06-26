/**
 * APP SECUNDARIA: APP_OFICIAL2 -> proyecto `acreditaciones-b904f`
 * ---------------------------------------------------------------------
 * Se usa EXCLUSIVAMENTE para leer la "jornada activa" desde su Realtime
 * Database. Es un proyecto Firebase distinto al POS, por lo que requiere su
 * propio service account y la URL de la Realtime DB.
 *
 * Inicialización perezosa: si faltan credenciales no rompe el arranque;
 * el endpoint de jornadas devolverá un error 503 claro.
 */

import * as admin from "firebase-admin";
import {
  loadServiceAccountFromFile,
  resolveServiceAccountPath,
} from "./service-account.util";

const APP_NAME = "APP_OFICIAL2";

const REALTIME_DB_URL =
  process.env.REALTIME_DATABASE_URL_APP_OFICIAL2?.trim() ||
  "https://acreditaciones-b904f-default-rtdb.firebaseio.com";

class AppOficial2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppOficial2Error";
  }
}

function loadServiceAccount(): admin.ServiceAccount | null {
  const inline = process.env.SERVICE_ACCOUNT_APP_OFICIAL2;
  if (inline && inline.trim()) {
    try {
      return JSON.parse(inline) as admin.ServiceAccount;
    } catch {
      throw new AppOficial2Error(
        "SERVICE_ACCOUNT_APP_OFICIAL2 no es un JSON válido.",
      );
    }
  }

  const resolvedPath = resolveServiceAccountPath({
    fromDir: __dirname,
    explicitPath: process.env.SERVICE_ACCOUNT_APP_OFICIAL2_PATH,
    projectId: "acreditaciones-b904f",
    extraFilenames: ["acreditaciones.serviceAccountKey.json"],
  });

  if (resolvedPath) {
    return loadServiceAccountFromFile(resolvedPath);
  }

  return null;
}

function getOrCreateApp(): admin.app.App | null {
  const existing = admin.apps.find((a) => a?.name === APP_NAME);
  if (existing) {
    return existing;
  }

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    return null;
  }

  return admin.initializeApp(
    {
      credential: admin.credential.cert(serviceAccount),
      databaseURL: REALTIME_DB_URL,
    },
    APP_NAME,
  );
}

export function isAppOficial2Configured(): boolean {
  return Boolean(getOrCreateApp());
}

/** Devuelve la Realtime Database de APP_OFICIAL2. */
export function getRealtimeDbAppOficial2(): admin.database.Database {
  const app = getOrCreateApp();
  if (!app) {
    throw new AppOficial2Error(
      "Conexión a 'acreditaciones-b904f' (jornadas) no configurada. Define SERVICE_ACCOUNT_APP_OFICIAL2 (o coloca acreditaciones.serviceAccountKey.json) y REALTIME_DATABASE_URL_APP_OFICIAL2.",
    );
  }
  return app.database();
}

export { AppOficial2Error };
