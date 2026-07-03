import "./config/env.bootstrap";
import app from "./app";

// Verificar el entorno
if (process.env.IS_LOCAL !== "true") {
  console.warn(
    "ADVERTENCIA: Estas ejecutando el servidor de desarrollo sin IS_LOCAL=true",
  );
}

if (!process.env.JWT_SECRET?.trim()) {
  console.error(
    "ERROR: JWT_SECRET no está definido en functions/.env.local.\n" +
      "  Agrégalo (el mismo valor que BackendCL en producción):\n" +
      "  JWT_SECRET=tu_secreto_compartido\n" +
      "  JWT_EXPIRES_IN=7d",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log("----------------------------------------------------------");
  console.log("  POS Concesiones Estadio - Servidor Local Activo");
  console.log(`  API URL:   http://localhost:${PORT}/api`);
  console.log(`  Health:    http://localhost:${PORT}/api`);
  console.log(`  Swagger:   http://localhost:${PORT}/api-docs (o /docs)`);
  console.log("  Admin SDK: Inicializado");
  console.log("  JWT:       configurado");
  console.log("----------------------------------------------------------");
});
