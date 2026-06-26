import "./config/env.bootstrap";
import app from "./app";

// Verificar el entorno
if (process.env.IS_LOCAL !== "true") {
  console.warn(
    "ADVERTENCIA: Estas ejecutando el servidor de desarrollo sin IS_LOCAL=true",
  );
}

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log("----------------------------------------------------------");
  console.log("  POS Concesiones Estadio - Servidor Local Activo");
  console.log(`  API URL:   http://localhost:${PORT}/api`);
  console.log(`  Health:    http://localhost:${PORT}/api`);
  console.log(`  Swagger:   http://localhost:${PORT}/api-docs (o /docs)`);
  console.log("  Admin SDK: Inicializado");
  console.log("----------------------------------------------------------");
});
