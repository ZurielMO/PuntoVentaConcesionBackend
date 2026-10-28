/**
 * Desvincula cajeros de cajas sin borrar usuarios.
 *
 * 1) `usuariosApp.cajaId = null` en vendedores de concesión.
 * 2) `asignaciones_cajas_jornada.activo = false` (el historial se conserva).
 *
 * Uso (desde functions/):
 *   npm run unlink-vendedores-cajas:dry
 *   npm run unlink-vendedores-cajas
 */
import "../src/config/env.bootstrap";
import { FieldValue } from "firebase-admin/firestore";
import { firestoreApp, USUARIOS_APP_COLLECTION } from "../src/config/app.firebase";
import { firestorePos } from "../src/config/firebase";
import { COLLECTIONS } from "../src/config/firestore.constants";
import { toInternalRole } from "../src/utils/concesion-roles";
import { UserRole } from "../src/models";

const BATCH_LIMIT = 400;
const dryRun = process.argv.includes("--dry-run");

const hasCajaId = (value: unknown): boolean =>
  typeof value === "string" ? value.trim().length > 0 : value != null;

const isVendedor = (rol: unknown): boolean =>
  toInternalRole(typeof rol === "string" ? rol : null) === UserRole.VENDEDOR;

const commitInBatches = async (
  refs: FirebaseFirestore.DocumentReference[],
  patch: Record<string, unknown>,
  label: string,
): Promise<number> => {
  if (dryRun) {
    console.log(`[dry-run] ${label}: ${refs.length} documento(s)`);
    return refs.length;
  }

  let written = 0;
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const chunk = refs.slice(i, i + BATCH_LIMIT);
    const db = chunk[0]?.firestore;
    if (!db) continue;
    const batch = db.batch();
    for (const ref of chunk) {
      batch.update(ref, patch);
    }
    await batch.commit();
    written += chunk.length;
    console.log(`${label}: ${written}/${refs.length}`);
  }
  return written;
};

async function unlinkPerfiles(): Promise<number> {
  const snap = await firestoreApp
    .collection(USUARIOS_APP_COLLECTION)
    .where("from_concesion", "==", true)
    .get();

  const refs = snap.docs
    .filter((doc) => {
      const data = doc.data() ?? {};
      return isVendedor(data.rol) && hasCajaId(data.cajaId);
    })
    .map((doc) => doc.ref);

  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    if (isVendedor(data.rol) && hasCajaId(data.cajaId)) {
      console.log(
        `  perfil ${doc.id} ${data.email ?? ""} cajaId=${data.cajaId}`,
      );
    }
  }

  return commitInBatches(
    refs,
    { cajaId: null, updatedAt: FieldValue.serverTimestamp() },
    "usuariosApp",
  );
}

async function unlinkAsignacionesJornada(): Promise<number> {
  const snap = await firestorePos
    .collection(COLLECTIONS.ASIGNACIONES_CAJAS_JORNADA)
    .where("activo", "==", true)
    .get();

  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    console.log(
      `  jornada ${data.jornadaId ?? "?"} sucursal=${data.sucursalId ?? "?"} caja=${data.cajaId ?? "?"} vendedor=${data.vendedorUid ?? "?"}`,
    );
  }

  return commitInBatches(
    snap.docs.map((doc) => doc.ref),
    { activo: false, updatedAt: FieldValue.serverTimestamp() },
    "asignaciones_cajas_jornada",
  );
}

async function main() {
  console.log(
    dryRun
      ? "Dry-run: no se escribe nada.\n"
      : "Desvinculando cajeros de cajas (los usuarios se conservan).\n",
  );

  const perfiles = await unlinkPerfiles();
  const asignaciones = await unlinkAsignacionesJornada();

  console.log(
    `\nListo. Perfiles con cajaId limpiado: ${perfiles}. Asignaciones de jornada desactivadas: ${asignaciones}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
