/**
 * Prueba E2E local: login → crear producto con imagen vía proxy Next → verificar URL → DELETE 204.
 * Uso: npx ts-node --transpile-only scripts/test-proxy-flow.ts
 */
import "../src/config/env.bootstrap";
import { authAdmin, firestorePos } from "../src/config/firebase";
import { COLLECTIONS } from "../src/config/firestore.constants";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const FRONTEND = process.env.TEST_FRONTEND_URL ?? "http://localhost:9002";
const API_KEY =
  process.env.FIREBASE_API_KEY ??
  process.env.NEXT_PUBLIC_AUTH_FIREBASE_API_KEY ??
  "";

const MINI_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIj/2wBDAQMDAwMEAwMEBgUFBgUGCAYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGoAP/Z",
  "base64",
);

async function getTestAuth(): Promise<{ token: string; concesionId: string }> {
  const usersSnap = await firestorePos
    .collection(COLLECTIONS.USERS)
    .where("activo", "==", true)
    .limit(20)
    .get();

  const adminUser = usersSnap.docs.find((doc) => {
    const data = doc.data();
    const rol = String(data.rol ?? "").toUpperCase();
    const hasConcession = Boolean(data.concesionId || data.idConcesion);
    return rol === "ADMIN" && hasConcession;
  }) ?? usersSnap.docs.find((doc) => {
    const rol = String(doc.data().rol ?? "").toUpperCase();
    return rol === "SUPERADMIN";
  });

  if (!adminUser) {
    throw new Error("No hay usuario ADMIN/SUPERADMIN activo en Firestore");
  }

  const data = adminUser.data();
  const uid = (data.uid as string) || adminUser.id;
  const concesionId =
    (data.concesionId as string) ||
    (data.idConcesion as string) ||
    "";

  if (!concesionId) {
    const conSnap = await firestorePos
      .collection(COLLECTIONS.CONCESIONES)
      .limit(1)
      .get();
    if (conSnap.empty) {
      throw new Error("Usuario sin concesión y no hay concesiones en Firestore");
    }
    return { token: await exchangeCustomToken(uid), concesionId: conSnap.docs[0].id };
  }

  return { token: await exchangeCustomToken(uid), concesionId };
}

async function exchangeCustomToken(uid: string): Promise<string> {
  if (!API_KEY) {
    throw new Error("Falta FIREBASE_API_KEY en .env.local");
  }
  const customToken = await authAdmin.createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const json = (await res.json()) as { idToken?: string; error?: { message: string } };
  if (!res.ok || !json.idToken) {
    throw new Error(`Custom token exchange failed: ${json.error?.message ?? res.status}`);
  }
  return json.idToken;
}

async function main() {
  console.log("=== Test proxy upload/delete ===");
  console.log(`Frontend proxy: ${FRONTEND}/api`);

  const health = await fetch(`${FRONTEND}/api/products`, {
    headers: { Authorization: "Bearer invalid" },
  }).catch(() => null);
  if (!health) {
    throw new Error(`Frontend no responde en ${FRONTEND}. ¿npm run dev en :9002?`);
  }

  const { token, concesionId } = await getTestAuth();
  console.log(`Auth OK — concesionId: ${concesionId}`);

  const tmpFile = path.join(os.tmpdir(), `test-product-${Date.now()}.jpg`);
  fs.writeFileSync(tmpFile, MINI_JPEG);

  const form = new FormData();
  form.append("nombre", `Test proxy ${Date.now()}`);
  form.append("unidad_medida", "Unidad");
  form.append("precio", "9.99");
  form.append("activo", "true");
  form.append("concesionId", concesionId);
  form.append(
    "images",
    new Blob([MINI_JPEG], { type: "image/jpeg" }),
    "test.jpg",
  );

  const createRes = await fetch(`${FRONTEND}/api/products`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const createBody = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`POST /products falló ${createRes.status}: ${createBody}`);
  }

  const created = JSON.parse(createBody) as {
    data?: { id?: string; imagenes?: string[] };
  };
  const productId = created.data?.id;
  const imageUrl = created.data?.imagenes?.[0];

  if (!productId) {
    throw new Error(`Respuesta sin product id: ${createBody}`);
  }
  console.log(`Producto creado: ${productId}`);

  if (!imageUrl) {
    throw new Error("Producto creado sin imagen — multipart proxy sigue roto");
  }
  console.log(`Imagen URL: ${imageUrl}`);

  const imgRes = await fetch(imageUrl);
  const imgType = imgRes.headers.get("content-type") ?? "";
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());

  if (!imgRes.ok) {
    throw new Error(`Imagen no accesible: HTTP ${imgRes.status}`);
  }
  if (!imgType.includes("image")) {
    throw new Error(`Content-Type inesperado: ${imgType}`);
  }
  if (imgBytes.length < 100) {
    throw new Error(`Imagen demasiado pequeña (${imgBytes.length} bytes) — posible corrupción`);
  }
  if (imgBytes[0] !== 0xff || imgBytes[1] !== 0xd8) {
    throw new Error("Bytes no corresponden a JPEG válido (sin magic FF D8)");
  }
  console.log(`Imagen OK — ${imgBytes.length} bytes, ${imgType}`);

  const deleteRes = await fetch(`${FRONTEND}/api/products/${productId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (deleteRes.status !== 204) {
    const delBody = await deleteRes.text();
    throw new Error(`DELETE esperaba 204, recibió ${deleteRes.status}: ${delBody}`);
  }
  console.log("DELETE OK — 204 sin error de proxy");

  fs.unlinkSync(tmpFile);
  console.log("\n✅ Todos los tests pasaron");
}

main().catch((err) => {
  console.error("\n❌ Test falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
