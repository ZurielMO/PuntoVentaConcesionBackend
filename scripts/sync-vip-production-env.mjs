/**
 * Sincroniza secretos/env VIP a producción (puntoventacl) desde functions/.env.local.
 * No imprime valores. Conserva JWT/CORS/API key ya desplegados en apiV2.
 *
 *   node scripts/sync-vip-production-env.mjs
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const project = "puntoventacl";
const region = "us-central1";

const VIP_SECRETS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "VIP_TRACKING_SECRET",
  "BREVO_API_KEY",
  "BREVO_SENDER_EMAIL",
  "BREVO_SENDER_NAME",
];

const FIREBASE_INJECTED_ENV = new Set([
  "EVENTARC_CLOUD_EVENT_SOURCE",
  "FIREBASE_CONFIG",
  "FUNCTION_REGION",
  "FUNCTION_TARGET",
  "GCLOUD_PROJECT",
  "LOG_EXECUTION_ID",
]);

const parseEnvFile = (filePath) => {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
};

const local = parseEnvFile(path.join(root, "functions", ".env.local"));

const describeRaw = spawnSync(
  "gcloud",
  [
    "functions",
    "describe",
    "apiV2",
    "--gen2",
    `--region=${region}`,
    `--project=${project}`,
    "--format=json",
  ],
  { encoding: "utf8", shell: true },
);
if (describeRaw.status !== 0) {
  console.error(describeRaw.stderr || "gcloud functions describe failed");
  process.exit(describeRaw.status ?? 1);
}
const describe = JSON.parse(describeRaw.stdout);
const liveEnv = describe.serviceConfig?.environmentVariables || {};

const envLines = [];
const keepOrder = [
  "PROJECT_ID",
  "FIRESTORE_DATABASE_ID",
  "STORAGE_BUCKET",
  "AUTH_API_KEY",
  "JWT_SECRET",
  "JWT_EXPIRES_IN",
  "CORS_ALLOWED_ORIGINS",
  "STORE_PUBLIC_BASE_URL",
  "STRIPE_CURRENCY",
  "VIP_CHECKOUT_SUCCESS_URL",
  "VIP_CHECKOUT_CANCEL_URL",
  "VIP_RESERVATION_TTL_MINUTES",
  "VIP_SERVICE_FEE",
  "VIP_CENTRAL_ZONE_PASSWORD",
];

const merged = {};
for (const [key, value] of Object.entries(liveEnv)) {
  if (!FIREBASE_INJECTED_ENV.has(key) && String(value || "").trim()) {
    merged[key] = String(value);
  }
}
if (merged.FIREBASE_API_KEY && !merged.AUTH_API_KEY) {
  merged.AUTH_API_KEY = merged.FIREBASE_API_KEY;
}
delete merged.FIREBASE_API_KEY;
delete merged.FIREBASE_PROJECT_ID;

merged.PROJECT_ID = merged.PROJECT_ID || "puntoventacl";
merged.FIRESTORE_DATABASE_ID = merged.FIRESTORE_DATABASE_ID || "concesiones";
merged.STORAGE_BUCKET =
  merged.STORAGE_BUCKET || "puntoventacl.firebasestorage.app";
merged.STRIPE_CURRENCY = local.STRIPE_CURRENCY || merged.STRIPE_CURRENCY || "mxn";
merged.VIP_CHECKOUT_SUCCESS_URL =
  "https://concesiones.clubleon.mx/servicio-palcos/pago/exito?cs={CHECKOUT_SESSION_ID}";
merged.VIP_CHECKOUT_CANCEL_URL =
  "https://concesiones.clubleon.mx/servicio-palcos/pago/cancelado";
merged.VIP_RESERVATION_TTL_MINUTES = local.VIP_RESERVATION_TTL_MINUTES || "30";
merged.VIP_SERVICE_FEE = local.VIP_SERVICE_FEE || "20";
if (local.VIP_CENTRAL_ZONE_PASSWORD) {
  merged.VIP_CENTRAL_ZONE_PASSWORD = local.VIP_CENTRAL_ZONE_PASSWORD;
}

const cors = new Set(
  String(merged.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
for (const origin of [
  "https://concesiones.clubleon.mx",
  "https://foodmarket.clubleon.mx",
  "http://localhost:9002",
]) {
  cors.add(origin);
}
merged.CORS_ALLOWED_ORIGINS = [...cors].join(",");

for (const key of keepOrder) {
  if (merged[key]) envLines.push(`${key}=${merged[key]}`);
}
for (const key of Object.keys(merged).sort()) {
  if (!keepOrder.includes(key) && merged[key]) {
    envLines.push(`${key}=${merged[key]}`);
  }
}

const envFile = path.join(root, "functions", ".env.puntoventacl");
fs.writeFileSync(envFile, `${envLines.join("\n")}\n`, { encoding: "utf8" });
console.log(`Wrote ${path.relative(root, envFile)} with ${envLines.length} keys (values hidden).`);

const missingSecrets = [];
for (const name of VIP_SECRETS) {
  const value = local[name];
  if (!value) {
    missingSecrets.push(name);
    console.log(`SKIP secret ${name}: empty in .env.local`);
    continue;
  }
  if (name === "STRIPE_SECRET_KEY" && value.startsWith("sk_test_")) {
    console.log("WARN STRIPE_SECRET_KEY is a TEST key (sk_test_). Production checkout will run in Stripe test mode.");
  }
  const tmp = path.join(os.tmpdir(), `puntoventa-secret-${name}.txt`);
  fs.writeFileSync(tmp, value, { encoding: "utf8", mode: 0o600 });
  try {
    const result = spawnSync(
      "npx",
      [
        "-y",
        "firebase-tools@latest",
        "functions:secrets:set",
        name,
        `--project=${project}`,
        `--data-file=${tmp}`,
        "-f",
      ],
      { cwd: root, stdio: "inherit", shell: true },
    );
    if (result.status !== 0) {
      console.error(`Failed to set secret ${name}`);
      process.exit(result.status ?? 1);
    }
    console.log(`SET secret ${name} (${value.length} chars)`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

if (missingSecrets.length) {
  console.error(`Missing VIP secrets in .env.local: ${missingSecrets.join(", ")}`);
  process.exit(1);
}

console.log("Secrets and project env file are ready. Deploy functions next.");
