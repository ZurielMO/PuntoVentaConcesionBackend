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

// Exportar la API de Express como una Cloud Function HTTPS.
// Agrega aquí los secrets requeridos (secrets: [...]) cuando los necesites.
export const api = onRequest(
  {
    memory: "1GiB",
    invoker: "public",
  },
  (req, res) => {
    app(req, res);
  },
);
