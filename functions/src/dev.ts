import "./config/env.bootstrap";
import os from "os";
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

// 0.0.0.0 para que las terminales físicas de la LAN puedan conectarse.
// Con el default de Node (loopback en algunas configuraciones) solo llegaría el PC.
const HOST = process.env.HOST?.trim() || "0.0.0.0";

/** IPv4 de los adaptadores físicos, para pegar en dart_defines/physical.json. */
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((addr) => addr.family === "IPv4" && !addr.internal)
    .map((addr) => addr.address);
}

app.listen(PORT, HOST, () => {
  console.log("----------------------------------------------------------");
  console.log("  POS Concesiones Estadio - Servidor Local Activo");
  console.log(`  Escuchando en: ${HOST}:${PORT}`);
  console.log(`  API URL:   http://localhost:${PORT}/api`);
  console.log(`  Swagger:   http://localhost:${PORT}/api-docs (o /docs)`);
  console.log(`  Emulador:  http://10.0.2.2:${PORT}/api`);
  for (const ip of lanAddresses()) {
    console.log(`  Red LAN:   http://${ip}:${PORT}/api`);
  }
  console.log("  Admin SDK: Inicializado");
  console.log("  JWT:       configurado");
  console.log("----------------------------------------------------------");
  console.log(
    "  Terminal física: usa la URL de 'Red LAN'. En PuntoVentaApp corre\n" +
      "  'dart run tool/set_lan_ip.dart' para fijarla automáticamente.",
  );
  console.log("----------------------------------------------------------");
});
