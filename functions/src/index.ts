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
import { defineSecret } from "firebase-functions/params";
import app from "./app";

/**
 * JSON del service account de acreditaciones-b904f (Realtime DB jornada_activa).
 * Crear/actualizar:
 *   npx firebase-tools functions:secrets:set SERVICE_ACCOUNT_APP_OFICIAL2 --project puntoventacl --data-file=./acreditaciones-....json
 */
const serviceAccountAppOficial2 = defineSecret("SERVICE_ACCOUNT_APP_OFICIAL2");
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const vipTrackingSecret = defineSecret("VIP_TRACKING_SECRET");
const brevoApiKey = defineSecret("BREVO_API_KEY");
const brevoSenderEmail = defineSecret("BREVO_SENDER_EMAIL");
const brevoSenderName = defineSecret("BREVO_SENDER_NAME");

/**
 * Credenciales de la cuenta de integración con BackendCL (Club León).
 *
 * Sin ellas `loginToBackendCl()` aborta con LOYALTY_NOT_CONFIGURED antes de
 * emitir la petición, y toda acumulación de puntos del POS queda pendiente.
 * Fue la causa del incidente de puntos: estaban en `.env.local` pero nunca
 * llegaron al runtime desplegado, porque el deploy no publica archivos .env.
 *
 * Crear/actualizar:
 *   npx firebase-tools functions:secrets:set BACKENDCL_AUTH_EMAIL --project puntoventacl
 *   npx firebase-tools functions:secrets:set BACKENDCL_AUTH_PASSWORD --project puntoventacl
 */
const backendClAuthEmail = defineSecret("BACKENDCL_AUTH_EMAIL");
const backendClAuthPassword = defineSecret("BACKENDCL_AUTH_PASSWORD");

/**
 * Cloud Function HTTPS Gen2.
 *
 * Nombre `apiV2` (no `api`) porque en producción ya existe `api` en Gen1
 * y Firebase no permite upgrade in-place Gen1 → Gen2 con el mismo nombre.
 *
 * URL: https://us-central1-puntoventacl.cloudfunctions.net/apiV2
 * Cuando el tráfico esté en Gen2, borrar la Gen1:
 *   firebase functions:delete api --region us-central1
 */
export const apiV2 = onRequest(
  {
    memory: "1GiB",
    invoker: "public",
    secrets: [
      serviceAccountAppOficial2,
      stripeSecretKey,
      stripeWebhookSecret,
      vipTrackingSecret,
      brevoApiKey,
      brevoSenderEmail,
      brevoSenderName,
      backendClAuthEmail,
      backendClAuthPassword,
    ],
  },
  (req, res) => {
    app(req, res);
  },
);

export { expireVipReservations } from "./vip-reservations.cron";
