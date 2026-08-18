/**
 * Sube el service account de acreditaciones-b904f a Secret Manager
 * y redeploya apiV2 para que jornadas/inventarios/cortes funcionen.
 *
 * Uso (desde la raíz del backend):
 *   node scripts/set-jornada-secret-and-deploy.mjs
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const project = process.env.GCLOUD_PROJECT || "puntoventacl";

function findAcreditacionesJson() {
  const files = fs
    .readdirSync(root)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        (f.includes("acreditaciones") || f.includes("firebase-adminsdk")),
    );
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(root, file), "utf8"),
      );
      if (parsed.project_id === "acreditaciones-b904f") {
        return path.join(root, file);
      }
    } catch {
      // ignore
    }
  }
  const fallback = path.join(root, "acreditaciones.serviceAccountKey.json");
  return fs.existsSync(fallback) ? fallback : null;
}

const jsonPath = findAcreditacionesJson();
if (!jsonPath) {
  console.error(
    "No encontré el JSON de acreditaciones-b904f en la raíz del repo.",
  );
  console.error(
    "Descárgalo desde Firebase Console → Project settings → Service accounts",
  );
  process.exit(1);
}

console.log("→ Usando:", path.basename(jsonPath));
console.log("→ Proyecto Firebase:", project);

const setResult = spawnSync(
  "npx",
  [
    "firebase-tools@latest",
    "functions:secrets:set",
    "SERVICE_ACCOUNT_APP_OFICIAL2",
    `--project=${project}`,
    `--data-file=${jsonPath}`,
    "-f",
  ],
  { cwd: root, stdio: "inherit", shell: true },
);

if (setResult.status !== 0) {
  console.error("Falló al crear/actualizar el secret.");
  process.exit(setResult.status ?? 1);
}

console.log("→ Redeploy apiV2…");
const deployResult = spawnSync(
  "npx",
  [
    "firebase-tools@latest",
    "deploy",
    "--only",
    "functions:apiV2",
    `--project=${project}`,
    "--non-interactive",
  ],
  { cwd: path.join(root, "functions"), stdio: "inherit", shell: true },
);

process.exit(deployResult.status ?? 1);
