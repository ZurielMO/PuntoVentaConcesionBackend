import { admin, hasAdminCredentials } from "./firebase.admin";
import { getFirestore } from "firebase-admin/firestore";
import { STORE_FIRESTORE_DATABASE } from "./firestore.constants";

const databaseId =
  process.env.FIRESTORE_DATABASE_ID?.trim() || STORE_FIRESTORE_DATABASE;

const app = admin.app();

/**
 * Firestore del proyecto POS (`puntoventacl`), base de datos NOMBRADA
 * "concesiones". Toda la lógica del POS usa esta instancia.
 */
export const firestorePos =
  databaseId && databaseId !== "(default)"
    ? getFirestore(app, databaseId)
    : getFirestore(app);

firestorePos.settings({ ignoreUndefinedProperties: true });

/** Alias para compatibilidad con código existente. */
export const firestore = firestorePos;

export const authAdmin = admin.auth();
export const storage = app.storage();

export { hasAdminCredentials };
