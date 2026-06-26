// config/firebase.admin.ts
import "./env.bootstrap";
import * as admin from "firebase-admin";
import {
  loadServiceAccountFromFile,
  resolveServiceAccountPath,
} from "./service-account.util";

/**
 * Indica si se cargaron credenciales explícitas (service account) para el
 * proyecto base. En Cloud Functions siempre hay credenciales del entorno.
 * En local, si no hay service account, las llamadas a Firestore/Auth fallarán,
 * por lo que exponemos este flag para responder 503 de forma clara.
 */
export let hasAdminCredentials = false;

if (!admin.apps.length) {
  const isCloudFunction = process.env.FUNCTION_NAME || process.env.K_SERVICE;

  if (isCloudFunction) {
    admin.initializeApp();
    hasAdminCredentials = true;
  } else {
    let serviceAccount: admin.ServiceAccount | undefined;

    const projectId =
      process.env.PROJECT_ID ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GCP_PROJECT_ID;

    const resolvedPath = resolveServiceAccountPath({
      fromDir: __dirname,
      explicitPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      projectId: projectId?.trim() || undefined,
    });

    if (resolvedPath) {
      serviceAccount = loadServiceAccountFromFile(resolvedPath);
    }

    if (!serviceAccount && process.env.SERVICE_ACCOUNT_KEY) {
      serviceAccount = JSON.parse(
        process.env.SERVICE_ACCOUNT_KEY,
      ) as admin.ServiceAccount;
    }

    const storageBucket =
      process.env.STORAGE_BUCKET ||
      (projectId ? `${projectId}.firebasestorage.app` : undefined);

    const config: admin.AppOptions = {};
    if (serviceAccount) {
      config.credential = admin.credential.cert(serviceAccount);
      hasAdminCredentials = true;
    }
    if (projectId) {
      config.projectId = projectId;
    }
    if (storageBucket) {
      config.storageBucket = storageBucket;
    }

    admin.initializeApp(config);
  }
}

console.log(
  "🔥 Firebase apps inicializadas:",
  admin.apps.map((app) => app?.name ?? "NULL"),
  hasAdminCredentials ? "(con credenciales)" : "(SIN credenciales)",
);

export { admin };
