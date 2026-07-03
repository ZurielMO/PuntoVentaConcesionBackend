/**
 * APP_OFICIAL: proyecto `app-oficial-leon`
 * ---------------------------------------------------------------------
 * Auth y perfiles de usuarios del POS viven aquí (colección usuariosApp).
 * Comparte el mismo stack que BackendCL (JWT_SECRET + Auth + Firestore).
 * El negocio POS (concesiones, inventarios, ventas) sigue en puntoventacl.
 *
 * Importa firebase.admin primero para que la app default ([DEFAULT]) exista
 * antes de registrar esta app nombrada.
 */

import "./firebase.admin";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  loadServiceAccountFromFile,
  resolveServiceAccountPath,
} from "./service-account.util";

const APP_NAME = "APP_OFICIAL";

class AppOficialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppOficialError";
  }
}

function loadServiceAccount(): admin.ServiceAccount | null {
  const inline = process.env.SERVICE_ACCOUNT_APP_OFICIAL;
  if (inline && inline.trim()) {
    try {
      return JSON.parse(inline) as admin.ServiceAccount;
    } catch {
      throw new AppOficialError(
        "SERVICE_ACCOUNT_APP_OFICIAL no es un JSON válido.",
      );
    }
  }

  const projectId = process.env.APP_OFICIAL_PROJECT_ID || "app-oficial-leon";
  const extraFilenames = [
    "serviceAccountAppOficial.json",
    "app-oficial-leon.serviceAccountKey.json",
  ];

  // 1) Preferir archivo de app-oficial filtrado por project_id
  let resolvedPath = resolveServiceAccountPath({
    fromDir: __dirname,
    explicitPath: process.env.SERVICE_ACCOUNT_APP_OFICIAL_PATH,
    projectId,
    extraFilenames,
  });

  // 2) Fallback: serviceAccountAppOficial.json aunque el project_id no coincida
  //    (evita fallar si el JSON usa otro campo o el env no está cargado aún)
  if (!resolvedPath) {
    resolvedPath = resolveServiceAccountPath({
      fromDir: __dirname,
      explicitPath: process.env.SERVICE_ACCOUNT_APP_OFICIAL_PATH,
      extraFilenames,
    });
  }

  if (resolvedPath) {
    return loadServiceAccountFromFile(resolvedPath);
  }

  return null;
}

function getOrCreateApp(
  serviceAccount: admin.ServiceAccount | null,
): admin.app.App {
  const existing = admin.apps.find((a) => a?.name === APP_NAME);
  if (existing) {
    return existing;
  }

  const projectId = process.env.APP_OFICIAL_PROJECT_ID || "app-oficial-leon";
  const storageBucket =
    process.env.APP_OFICIAL_STORAGE_BUCKET ||
    `${projectId}.firebasestorage.app`;

  const config: admin.AppOptions = {
    projectId,
    storageBucket,
  };

  if (serviceAccount) {
    config.credential = admin.credential.cert(serviceAccount);
  }

  return admin.initializeApp(config, APP_NAME);
}

const appOficialServiceAccount = loadServiceAccount();
const appOficial = getOrCreateApp(appOficialServiceAccount);

export const firestoreApp = getFirestore(appOficial);
firestoreApp.settings({ ignoreUndefinedProperties: true });

export const authAppOficial = getAuth(appOficial);

export const hasAppOficialCredentials = Boolean(appOficialServiceAccount);

export const USUARIOS_APP_COLLECTION = "usuariosApp";

console.log(
  "🔥 APP_OFICIAL:",
  appOficial.options.projectId,
  hasAppOficialCredentials ? "(con credenciales)" : "(SIN credenciales)",
);
