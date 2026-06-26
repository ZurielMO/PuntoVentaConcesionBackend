import "./config/env.bootstrap";
import express from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import routes from "./routes";
import { errorHandler, notFoundHandler } from "./utils/error-handler";
import { getSwaggerSpec } from "./config/swagger.config";
import { requestContextMiddleware } from "./middleware/request-context.middleware";
import {
  authMiddleware,
  requireAdmin,
  blockDebugInProduction,
} from "./utils/middlewares";
import { validateBody } from "./middleware/validation.middleware";
import { assignConcessionPointsSchema } from "./middleware/validators/concession.validator";
import { assignConcessionPoints } from "./controllers/concessions/concessions.command.controller";
import { getAllowedCorsOriginsWithStore } from "./config/cors.config";

const buildCorsOptions = (): CorsOptions => {
  const allowedOrigins = getAllowedCorsOriginsWithStore();
  const isCloudRuntime = Boolean(
    process.env.K_SERVICE || process.env.FUNCTION_NAME,
  );

  if (allowedOrigins.length === 0) {
    if (!isCloudRuntime && process.env.NODE_ENV !== "production") {
      return { origin: true, credentials: true };
    }
    return { origin: false, credentials: true };
  }

  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
    credentials: true,
  };
};

let corsOptionsCache: CorsOptions | null = null;
const getCorsOptions = (): CorsOptions => {
  if (!corsOptionsCache) {
    corsOptionsCache = buildCorsOptions();
  }
  return corsOptionsCache;
};

const app = express();
const isProductionRuntime =
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.K_SERVICE || process.env.FUNCTION_NAME);

/**
 * En Cloud Functions el prefijo /api lo aporta el nombre de la function.
 * En local reescribimos /api/* -> /* para que las rutas internas sean relativas.
 */
app.use((req, _res, next) => {
  if (req.url === "/api") {
    req.url = "/";
  } else if (req.url.startsWith("/api/")) {
    req.url = req.url.slice(4) || "/";
  }
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: false,
    hsts: isProductionRuntime
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
  }),
);
app.use((req, res, next) => cors(getCorsOptions())(req, res, next));
app.use(requestContextMiddleware);
app.use(blockDebugInProduction);

app.use(express.json({ limit: "32mb" }));
app.use(express.urlencoded({ limit: "32mb", extended: true }));

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// Swagger UI en /docs y /api-docs.
const swaggerSpec = getSwaggerSpec();
const swaggerSetup = swaggerUi.setup(swaggerSpec, {
  customCss: ".swagger-ui .topbar { display: none }",
  customSiteTitle: "POS Concesiones Estadio - API Docs",
});
app.use("/docs", swaggerUi.serve, swaggerSetup);
app.use("/api-docs", swaggerUi.serve, swaggerSetup);

// Shortcut explícito para la ruta con typo intencional, ANTES del router,
// para evitar que "/concessions/:id" capture la ruta.
app.post(
  "/concessions/asignarPuntosConsecion",
  authMiddleware,
  requireAdmin,
  validateBody(assignConcessionPointsSchema),
  assignConcessionPoints,
);

app.use("/", routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
