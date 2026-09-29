/**
 * Solo lectura: foto de ventas, inventarios y cortes de las jornadas objetivo.
 * Se usa antes y después de purge-jornadas-prueba.ts para comparar.
 *
 *   npx ts-node --transpile-only scripts/inspect-jornadas-prueba.ts
 */
import "../src/config/env.bootstrap";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../src/config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../src/config/firestore.constants";

const OBJETIVOS = [
  { fecha: "2026-09-12", numero: 8 },
  { fecha: "2026-09-14", numero: 8 },
];

/** Rango UTC del día natural en hora de México (CST fijo, UTC-6). */
const dayRangeUtc = (fecha: string) => {
  const start = new Date(`${fecha}T06:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: Timestamp.fromDate(start), end: Timestamp.fromDate(end) };
};

const main = async (): Promise<void> => {
  for (const { fecha, numero } of OBJETIVOS) {
    const jornadaId = `${fecha}__J${numero}`;
    console.log(`\n================ ${jornadaId} (varonil) ================`);

    const invCol = firestorePos.collection(COLLECTIONS.INVENTARIOS);
    const invSnap = await invCol
      .where(FieldPath.documentId(), ">=", `${fecha}__`)
      .where(FieldPath.documentId(), "<", `${fecha}__\uf8ff`)
      .get();

    console.log(`-- inventarios del día ${fecha}: ${invSnap.size}`);
    for (const doc of invSnap.docs) {
      const d = doc.data();
      const [productos, movimientos] = await Promise.all([
        doc.ref.collection(SUBCOLLECTIONS.PRODUCTOS).get(),
        doc.ref.collection(SUBCOLLECTIONS.MOVIMIENTOS).get(),
      ]);
      console.log(
        `   ${doc.id}  rama=${d.rama ?? "-"} activo=${d.activo} ` +
          `suc=${d.sucursal_id ?? "-"} jnum=${d.jornada_numero ?? "-"} ` +
          `productos=${productos.size} movimientos=${movimientos.size}`,
      );
    }

    const ventasCol = firestorePos.collection(COLLECTIONS.COMPROBANTES_VENTA);
    const { start, end } = dayRangeUtc(fecha);
    const [porJornada, porDia] = await Promise.all([
      ventasCol.where("jornadaId", "==", jornadaId).get(),
      ventasCol.where("fecha", ">=", start).where("fecha", "<", end).get(),
    ]);
    console.log(
      `-- ventas jornadaId==${jornadaId}: ${porJornada.size} | ` +
        `ventas con fecha en el día: ${porDia.size}`,
    );
    const porJornadaDelDia = new Map<string, number>();
    for (const doc of porDia.docs) {
      const key = String(doc.data().jornadaId ?? "(sin jornadaId)");
      porJornadaDelDia.set(key, (porJornadaDelDia.get(key) ?? 0) + 1);
    }
    for (const [key, count] of porJornadaDelDia) {
      console.log(`   ${String(count).padStart(4)}  jornadaId=${key}`);
    }

    const cortesCol = firestorePos.collection(COLLECTIONS.CORTES);
    const [cortesJornada, cortesFecha] = await Promise.all([
      cortesCol.where("jornadaId", "==", jornadaId).get(),
      cortesCol.where("fecha", "==", fecha).get(),
    ]);
    const cortes = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    for (const doc of [...cortesJornada.docs, ...cortesFecha.docs]) {
      cortes.set(doc.ref.path, doc);
    }
    console.log(`-- cortes del día ${fecha}: ${cortes.size}`);
    for (const doc of cortes.values()) {
      const d = doc.data();
      console.log(
        `   ${doc.id}  jornada=${d.jornadaId ?? "-"} inv=${d.inventarioId ?? "-"} ` +
          `estado=${d.estado ?? "-"}`,
      );
    }
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
