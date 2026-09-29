/**
 * Solo lectura: diagnostica la discrepancia de rama del panel de inventarios.
 * Vuelca los nodos RTDB de jornada activa, los inventarios del día y el
 * resultado real de getInventarioJornadaActiva para cada rama.
 *
 *   npx ts-node --transpile-only scripts/dump-jornada-activa.ts
 */
import "../src/config/env.bootstrap";
import { FieldPath } from "firebase-admin/firestore";
import { firestorePos } from "../src/config/firebase";
import {
  getRealtimeDbAppOficial2,
  isAppOficial2Configured,
} from "../src/config/firebase.appoficial2";
import { COLLECTIONS } from "../src/config/firestore.constants";
import * as jornadaService from "../src/services/jornada.service";
import * as inventarioService from "../src/services/inventario.service";

const FECHA = "2026-09-12";

const main = async (): Promise<void> => {
  console.log(`appOficial2Configured = ${isAppOficial2Configured()}`);

  const db = getRealtimeDbAppOficial2();
  for (const path of ["jornada_activa", "jornada_activa_femenil"]) {
    const snap = await db.ref(path).get();
    console.log(`\n===== RTDB ${path} =====`);
    console.log(snap.exists() ? JSON.stringify(snap.val(), null, 2) : "(no existe)");
  }

  console.log("\n===== /jornadas/activa =====");
  console.log(JSON.stringify(await jornadaService.getJornadaActiva(), null, 2));
  console.log(
    JSON.stringify(await jornadaService.getJornadasActivasPorRama(), null, 2),
  );

  console.log(`\n===== inventarios con prefijo ${FECHA}__ =====`);
  const invSnap = await firestorePos
    .collection(COLLECTIONS.INVENTARIOS)
    .where(FieldPath.documentId(), ">=", `${FECHA}__`)
    .where(FieldPath.documentId(), "<", `${FECHA}__\uf8ff`)
    .get();
  if (!invSnap.size) console.log("(ninguno)");
  for (const doc of invSnap.docs) {
    const d = doc.data();
    console.log(
      `  ${doc.id}  rama=${d.rama} activo=${d.activo} sucursal=${d.sucursal_id}`,
    );
  }

  const sucursales = new Set(
    invSnap.docs.map((d) => String(d.data().sucursal_id ?? "")),
  );
  console.log("\n===== sucursales involucradas =====");
  for (const id of sucursales) {
    if (!id) continue;
    const s = await firestorePos.collection(COLLECTIONS.SUCURSALES).doc(id).get();
    console.log(`  ${id} => ${s.data()?.nombre ?? "(sin nombre)"}`);
  }

  for (const id of sucursales) {
    if (!id) continue;
    for (const rama of ["varonil", "femenil"] as const) {
      console.log(`\n===== getInventarioJornadaActiva(${id}, ${rama}) =====`);
      try {
        const r = await inventarioService.getInventarioJornadaActiva(
          id,
          false,
          rama,
        );
        console.log(`  inventario = ${(r.inventario as { id?: string })?.id ?? null}`);
        console.log(`  jornada    = ${JSON.stringify(r.jornada)}`);
      } catch (err) {
        console.log(`  THROW: ${(err as Error).message}`);
      }
    }
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
