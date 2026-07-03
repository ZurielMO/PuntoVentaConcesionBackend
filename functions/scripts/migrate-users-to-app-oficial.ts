/**
 * Migración one-shot: users (puntoventacl / concesiones) → usuariosApp (app-oficial-leon).
 *
 * Uso (desde functions/):
 *   npm run migrate:users-app-oficial
 *   npm run migrate:users-app-oficial -- --promote-conflicts
 *
 * --promote-conflicts:
 *   Si el email ya es CLIENTE (u otro rol no-concesión) en usuariosApp pero
 *   existe en el POS, actualiza el doc a CONCESION_* + from_concesion=true
 *   SIN cambiar la contraseña (sigue siendo la de la app oficial).
 *
 * Contraseñas de usuarios NUEVOS: password temporal aleatorio (impreso en log).
 */

import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../src/config/firebase";
import {
  authAppOficial,
  firestoreApp,
  USUARIOS_APP_COLLECTION,
} from "../src/config/app.firebase";
import { COLLECTIONS } from "../src/config/firestore.constants";
import { CONCESION_ROLES } from "../src/utils/concesion-roles";

const promoteConflicts = process.argv.includes("--promote-conflicts");

const mapRole = (rol?: string): string => {
  const upper = String(rol ?? "").toUpperCase();
  if (upper === "SUPERADMIN" || upper === "CONCESION_SUPERADMIN") {
    return CONCESION_ROLES.SUPERADMIN;
  }
  if (upper === "ADMIN" || upper === "CONCESION_ADMIN") {
    return CONCESION_ROLES.ADMIN;
  }
  return CONCESION_ROLES.VENDEDOR;
};

const randomPassword = (): string =>
  `Tmp-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}!`;

const isAlreadyConcesion = (data: FirebaseFirestore.DocumentData): boolean =>
  data.from_concesion === true &&
  String(data.rol ?? "").startsWith("CONCESION_");

async function main() {
  console.log(
    promoteConflicts
      ? "Modo: migrar + promover conflictos CLIENTE → CONCESION_*"
      : "Modo: migrar (conflictos se reportan; usa --promote-conflicts para resolverlos)",
  );

  const usersSnap = await firestorePos.collection(COLLECTIONS.USERS).get();
  console.log(`Usuarios POS encontrados: ${usersSnap.size}`);

  const results = {
    migrated: 0,
    linked: 0,
    promoted: 0,
    conflicts: 0,
    skipped: 0,
    errors: 0,
  };

  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const email = String(data.email ?? "")
      .toLowerCase()
      .trim();
    const nombre = String(data.nombre ?? email);
    const rol = mapRole(data.rol as string | undefined);

    if (!email) {
      console.warn(`[SKIP] ${doc.id}: sin email`);
      results.skipped++;
      continue;
    }

    try {
      let uid: string | null = null;
      let createdAuth = false;
      let tempPassword: string | null = null;
      let promoteExisting = false;

      try {
        const existing = await authAppOficial.getUserByEmail(email);
        uid = existing.uid;

        const existingDoc = await firestoreApp
          .collection(USUARIOS_APP_COLLECTION)
          .doc(uid)
          .get();

        if (existingDoc.exists) {
          const existingData = existingDoc.data() ?? {};
          if (isAlreadyConcesion(existingData)) {
            console.log(`[OK] ${email}: ya migrado (${uid})`);
            results.skipped++;
            continue;
          }

          if (!promoteConflicts) {
            console.warn(
              `[CONFLICTO] ${email}: ya existe en usuariosApp como rol=${existingData.rol} from_concesion=${existingData.from_concesion}. No se sobrescribe. Re-ejecuta con --promote-conflicts para convertirlo a usuario POS (mantiene su password actual).`,
            );
            results.conflicts++;
            continue;
          }

          promoteExisting = true;
        } else {
          // Auth existe pero sin doc: enlazar perfil
          results.linked++;
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "auth/user-not-found") {
          throw err;
        }
        tempPassword = randomPassword();
        const created = await authAppOficial.createUser({
          email,
          password: tempPassword,
          displayName: nombre,
          disabled: data.activo === false,
        });
        uid = created.uid;
        createdAuth = true;
      }

      if (!uid) {
        results.errors++;
        continue;
      }

      const existingSnap = await firestoreApp
        .collection(USUARIOS_APP_COLLECTION)
        .doc(uid)
        .get();
      const existingData = existingSnap.exists ? existingSnap.data() ?? {} : {};

      const payload: Record<string, unknown> = {
        uid,
        provider: existingData.provider ?? "email",
        nombre: nombre || existingData.nombre || email,
        email,
        fechaNacimiento:
          data.fecha_nacimiento ?? existingData.fechaNacimiento ?? null,
        fecha_nacimiento:
          data.fecha_nacimiento ?? existingData.fecha_nacimiento ?? null,
        edad: existingData.edad ?? 0,
        genero: existingData.genero ?? "",
        rol,
        activo: data.activo !== false,
        from_concesion: true,
        concesionId: data.concesionId ?? data.idConcesion ?? null,
        sucursalId: data.sucursalId ?? data.idSucursal ?? null,
        cajaId: data.cajaId ?? null,
        // Preservar loyalty / puntos si ya era CLIENTE
        puntosActuales: existingData.puntosActuales ?? 0,
        nivel: existingData.nivel ?? "Bronce",
        perfilCompleto: true,
        mustResetPassword: createdAuth,
        migratedFromPosAt: FieldValue.serverTimestamp(),
        legacyPosUserId: doc.id,
        legacyAppRol: promoteExisting ? existingData.rol ?? null : null,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (!existingSnap.exists) {
        payload.createdAt = FieldValue.serverTimestamp();
      }

      await firestoreApp
        .collection(USUARIOS_APP_COLLECTION)
        .doc(uid)
        .set(payload, { merge: true });
      await authAppOficial.setCustomUserClaims(uid, { admin: false, rol });

      if (createdAuth) {
        console.log(
          `[MIGRADO] ${email} → ${uid} rol=${rol} passwordTemporal=${tempPassword}`,
        );
        results.migrated++;
      } else if (promoteExisting) {
        console.log(
          `[PROMOVIDO] ${email} → ${uid} rol=${rol} (password de app-oficial se mantiene)`,
        );
        results.promoted++;
      } else {
        console.log(`[ENLAZADO] ${email} → ${uid} rol=${rol}`);
      }
    } catch (error) {
      console.error(`[ERROR] ${email}:`, error);
      results.errors++;
    }
  }

  console.log("\nResumen:", results);
  console.log(
    "\nNota: usuarios [MIGRADO] usan password temporal. Usuarios [PROMOVIDO] conservan su password de la app oficial.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
