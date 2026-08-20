/**
 * Crea o actualiza el cajero Cinépolis en Auth + usuariosApp (app-oficial-leon).
 *
 * Uso (desde functions/):
 *   npm run cinepolis:ensure-cashier
 *
 * Contraseña: CinepolisCL.2026 (o CINEPOLIS_CASHIER_PASSWORD en el entorno).
 * El login sigue siendo el del POS: /login con cinepoliscl@clubleon.mx.
 */

import { FieldValue } from "firebase-admin/firestore";
import { CINEPOLIS_CASHIER_EMAIL } from "../src/config/cinepolis.constants";
import {
  authAppOficial,
  firestoreApp,
  USUARIOS_APP_COLLECTION,
} from "../src/config/app.firebase";
import { CONCESION_ROLES } from "../src/utils/concesion-roles";

const PASSWORD =
  process.env.CINEPOLIS_CASHIER_PASSWORD?.trim() || "CinepolisCL.2026";
const DISPLAY_NAME = "Cinépolis";

async function main() {
  let uid: string;
  try {
    const existing = await authAppOficial.getUserByEmail(CINEPOLIS_CASHIER_EMAIL);
    uid = existing.uid;
    await authAppOficial.updateUser(uid, {
      password: PASSWORD,
      displayName: existing.displayName || DISPLAY_NAME,
      disabled: false,
      emailVerified: existing.emailVerified,
    });
    console.log(`[AUTH] Contraseña actualizada para ${CINEPOLIS_CASHIER_EMAIL} (${uid})`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "auth/user-not-found") {
      throw error;
    }
    const created = await authAppOficial.createUser({
      email: CINEPOLIS_CASHIER_EMAIL,
      password: PASSWORD,
      displayName: DISPLAY_NAME,
      disabled: false,
    });
    uid = created.uid;
    console.log(`[AUTH] Usuario creado ${CINEPOLIS_CASHIER_EMAIL} (${uid})`);
  }

  await authAppOficial.setCustomUserClaims(uid, {
    admin: false,
    rol: CONCESION_ROLES.VENDEDOR,
  });

  const ref = firestoreApp.collection(USUARIOS_APP_COLLECTION).doc(uid);
  const snap = await ref.get();
  const payload: Record<string, unknown> = {
    uid,
    email: CINEPOLIS_CASHIER_EMAIL,
    nombre: snap.data()?.nombre || DISPLAY_NAME,
    rol: CONCESION_ROLES.VENDEDOR,
    activo: true,
    from_concesion: true,
    concesionId: null,
    sucursalId: null,
    cajaId: null,
    provider: "email",
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!snap.exists) {
    payload.puntosActuales = 0;
    payload.nivel = "Bronce";
    payload.perfilCompleto = true;
    payload.createdAt = FieldValue.serverTimestamp();
    await ref.set(payload);
    console.log(`[USUARIOSAPP] Documento creado ${uid}`);
  } else {
    await ref.set(payload, { merge: true });
    console.log(`[USUARIOSAPP] Documento actualizado ${uid}`);
  }

  console.log(
    `\nListo. Login POS: ${CINEPOLIS_CASHIER_EMAIL} / (contraseña Cinépolis configurada)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
