/**
 * Concede al service account de deploy (CI) acceso a Secret Manager
 * para que `firebase deploy` con defineSecret no falle con 403.
 *
 * Preferido (usa tu login de Firebase CLI / Owner):
 *   npx -y firebase-tools@latest login
 *   node scripts/grant-ci-secret-manager-access.mjs
 *
 * Alternativa con key Owner:
 *   node scripts/grant-ci-secret-manager-access.mjs --credentials ./serviceAccountKey.json
 *
 * Opcional:
 *   --grant-to ./puntoventacl-firebase-adminsdk-XXXX.json
 *   --member=serviceAccount:EMAIL@....iam.gserviceaccount.com
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { createRequire as createRequireFromPath } from "module";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const project = process.env.GCLOUD_PROJECT || "puntoventacl";
const projectNumber = process.env.GCLOUD_PROJECT_NUMBER || "777547113836";
const secretId = "SERVICE_ACCOUNT_APP_OFICIAL2";

const roles = [
  "roles/secretmanager.viewer",
  "roles/secretmanager.secretAccessor",
];

function parseArgs(argv) {
  const out = { credentials: null, grantTo: null, member: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--credentials") out.credentials = argv[++i];
    else if (a.startsWith("--credentials="))
      out.credentials = a.slice("--credentials=".length);
    else if (a === "--grant-to") out.grantTo = argv[++i];
    else if (a.startsWith("--grant-to="))
      out.grantTo = a.slice("--grant-to=".length);
    else if (a === "--member") out.member = argv[++i];
    else if (a.startsWith("--member=")) out.member = a.slice("--member=".length);
  }
  return out;
}

function readClientEmail(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const json = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (!json.client_email) {
    throw new Error(`Sin client_email en ${path.basename(abs)}`);
  }
  return json.client_email;
}

function findDefaultGrantTo() {
  const files = fs
    .readdirSync(root)
    .filter((f) => /^puntoventacl-firebase-adminsdk-.*\.json$/i.test(f));
  return files[0] ? path.join(root, files[0]) : null;
}

function findFirebaseToolsAuth() {
  const npxRoot = path.join(
    process.env.LOCALAPPDATA || "",
    "npm-cache",
    "_npx",
  );
  if (!fs.existsSync(npxRoot)) return null;
  const dirs = fs.readdirSync(npxRoot);
  for (const dir of dirs) {
    const authJs = path.join(
      npxRoot,
      dir,
      "node_modules",
      "firebase-tools",
      "lib",
      "auth.js",
    );
    if (fs.existsSync(authJs)) {
      const requireFt = createRequire(
        path.join(npxRoot, dir, "node_modules", "firebase-tools", "package.json"),
      );
      return requireFt("./lib/auth.js");
    }
  }
  // Ensure firebase-tools is cached
  spawnSync("npx", ["-y", "firebase-tools@latest", "--version"], {
    cwd: root,
    shell: true,
    stdio: "ignore",
  });
  for (const dir of fs.readdirSync(npxRoot)) {
    const pkg = path.join(
      npxRoot,
      dir,
      "node_modules",
      "firebase-tools",
      "package.json",
    );
    if (fs.existsSync(pkg)) {
      const requireFt = createRequire(pkg);
      return requireFt("./lib/auth.js");
    }
  }
  return null;
}

async function getAccessTokenFromFirebaseCli() {
  const auth = findFirebaseToolsAuth();
  if (!auth) return null;
  const account = auth.getGlobalDefaultAccount?.();
  if (!account?.tokens?.refresh_token) return null;
  const token = await auth.getAccessToken(account.tokens.refresh_token, []);
  if (typeof token === "string") return token;
  return token?.access_token || token?.token || null;
}

async function getAccessTokenFromKeyFile(credentialsPath) {
  const requireFromFunctions = createRequireFromPath(
    path.join(root, "functions", "package.json"),
  );
  const { GoogleAuth } = requireFromFunctions("google-auth-library");
  const googleAuth = new GoogleAuth({
    keyFile: credentialsPath,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  return typeof tokenResponse === "string"
    ? tokenResponse
    : tokenResponse?.token;
}

async function addProjectIamBinding(token, member, role) {
  const getUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`;
  const getRes = await fetch(getUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!getRes.ok) {
    throw new Error(`getIamPolicy (${role}): ${getRes.status} ${await getRes.text()}`);
  }
  const policy = await getRes.json();
  policy.bindings = policy.bindings || [];
  let binding = policy.bindings.find((b) => b.role === role);
  if (!binding) {
    binding = { role, members: [] };
    policy.bindings.push(binding);
  }
  binding.members = binding.members || [];
  if (binding.members.includes(member)) return "already";
  binding.members.push(member);

  const setRes = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:setIamPolicy`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ policy }),
    },
  );
  if (!setRes.ok) {
    throw new Error(`setIamPolicy (${role}): ${setRes.status} ${await setRes.text()}`);
  }
  return "added";
}

async function addSecretIamBinding(token, member, role) {
  const resource = `projects/${project}/secrets/${secretId}`;
  const getRes = await fetch(
    `https://secretmanager.googleapis.com/v1/${resource}:getIamPolicy`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!getRes.ok) {
    throw new Error(
      `secret getIamPolicy (${role}): ${getRes.status} ${await getRes.text()}`,
    );
  }
  const policy = await getRes.json();
  policy.bindings = policy.bindings || [];
  let binding = policy.bindings.find((b) => b.role === role);
  if (!binding) {
    binding = { role, members: [] };
    policy.bindings.push(binding);
  }
  binding.members = binding.members || [];
  if (binding.members.includes(member)) return "already";
  binding.members.push(member);

  const setRes = await fetch(
    `https://secretmanager.googleapis.com/v1/${resource}:setIamPolicy`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ policy }),
    },
  );
  if (!setRes.ok) {
    throw new Error(
      `secret setIamPolicy (${role}): ${setRes.status} ${await setRes.text()}`,
    );
  }
  return "added";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let member = args.member;
  if (!member) {
    const grantToPath = args.grantTo || findDefaultGrantTo();
    if (!grantToPath) {
      console.error(
        "Indica --grant-to <adminsdk.json> o --member=serviceAccount:email",
      );
      process.exit(1);
    }
    member = `serviceAccount:${readClientEmail(grantToPath)}`;
  }
  if (!member.startsWith("serviceAccount:")) {
    member = `serviceAccount:${member}`;
  }

  const computeMember = `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`;
  const members = [...new Set([member, computeMember])];

  let token = await getAccessTokenFromFirebaseCli();
  if (!token && args.credentials) {
    token = await getAccessTokenFromKeyFile(
      path.isAbsolute(args.credentials)
        ? args.credentials
        : path.join(root, args.credentials),
    );
  }
  if (!token) {
    console.error(
      "No hay credenciales. Ejecuta `npx firebase-tools@latest login` o pasa --credentials.",
    );
    process.exit(1);
  }

  console.log(`→ Proyecto: ${project}`);
  console.log(`→ Secreto: ${secretId}`);

  for (const m of members) {
    console.log(`→ Member: ${m}`);
    for (const role of roles) {
      console.log(`  project ${role}: ${await addProjectIamBinding(token, m, role)}`);
      console.log(`  secret  ${role}: ${await addSecretIamBinding(token, m, role)}`);
    }
  }

  console.log("Listo. Reintenta el deploy de GitHub Actions.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
