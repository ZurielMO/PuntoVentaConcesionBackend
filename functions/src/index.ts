import "./config/env.bootstrap";
/**
 * FIREBASE FUNCTIONS ENTRY POINT
 * ---------------------------------------------------------------------
 * Este es el ÚNICO archivo que Firebase lee directamente al iniciar.
 * Su responsabilidad es exportar los triggers de Cloud Functions.
 *
 * NOTA DE ARQUITECTURA:
 * Mantenemos este archivo minimalista. La lógica de la aplicación Express
 * vive en "app.ts", permitiendo que sea testeable independientemente
 * del entorno de Firebase.
 */

import { onRequest } from "firebase-functions/v2/https";
import app from "./app";

/**
 * Cloud Function HTTPS Gen2.
 *
 * Nombre `apiV2` (no `api`) porque en producción ya existe `api` en Gen1
 * y Firebase no permite upgrade in-place Gen1 → Gen2 con el mismo nombre.
 *
 * URL: https://us-central1-puntoventacl.cloudfunctions.net/apiV2
 * Cuando el tráfico esté en Gen2, borrar la Gen1:
 *   firebase functions:delete api --region us-central1
 *
 * Agrega aquí secrets: [...] cuando los necesites.
 */
export const apiV2 = onRequest(
  {
    memory: "1GiB",
    invoker: "public",
    secrets: ["SERVICE_ACCOUNT_APP_OFICIAL2"],
  },
  (req, res) => {
    app(req, res);
  },
);
