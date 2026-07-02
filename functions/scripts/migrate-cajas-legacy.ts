/**
 * Migra cajas legacy (doc id = nombre, sin campo nombre) agregando nombre y orden.
 * Uso: npx ts-node --transpile-only scripts/migrate-cajas-legacy.ts
 */
import "../src/config/env.bootstrap";
import { firestorePos } from "../src/config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../src/config/firestore.constants";
import { FieldValue } from "firebase-admin/firestore";

async function main() {
  const sucursalesSnap = await firestorePos.collection(COLLECTIONS.SUCURSALES).get();
  let updated = 0;

  for (const sucursalDoc of sucursalesSnap.docs) {
    const cajasSnap = await sucursalDoc.ref.collection(SUBCOLLECTIONS.CAJAS).get();
    for (const cajaDoc of cajasSnap.docs) {
      const data = cajaDoc.data();
      const patch: Record<string, unknown> = {};
      if (!data.nombre) patch.nombre = cajaDoc.id;
      if (data.activo === undefined) patch.activo = true;
      if (data.orden === undefined) patch.orden = 0;
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = FieldValue.serverTimestamp();
        await cajaDoc.ref.set(patch, { merge: true });
        updated += 1;
        console.log(`Actualizada caja ${sucursalDoc.id}/${cajaDoc.id}`);
      }
    }
  }

  console.log(`\nMigración completada. ${updated} caja(s) actualizadas.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
