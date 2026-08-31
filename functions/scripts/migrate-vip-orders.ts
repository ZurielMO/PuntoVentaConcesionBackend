import "../src/config/env.bootstrap";
import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../src/config/firebase";
import { COLLECTIONS } from "../src/config/firestore.constants";

const apply = process.argv.includes("--apply");
const requiredProductionFields = [
  "orderNumber",
  "jornadaId",
  "customer",
  "delivery",
  "items",
  "fulfillments",
  "payment",
  "status",
  "trackingTokenHash",
  "createdAt",
] as const;

async function main() {
  const snapshot = await firestorePos.collection(COLLECTIONS.VIP_ORDERS).get();
  const legacy = snapshot.docs.filter((doc) =>
    requiredProductionFields.some((field) => doc.data()[field] === undefined));

  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    scanned: snapshot.size,
    legacy: legacy.length,
    ids: legacy.map((doc) => doc.id),
    note: "Legacy documents are tagged for explicit review; customer/payment/inventory data is never invented.",
  }, null, 2));

  if (!apply || legacy.length === 0) return;
  let batch = firestorePos.batch();
  let count = 0;
  for (const doc of legacy) {
    batch.set(doc.ref, {
      legacySchema: true,
      schemaVersion: 0,
      migration: {
        reviewRequired: true,
        taggedBy: "migrate-vip-orders",
        taggedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    count += 1;
    if (count % 400 === 0) {
      await batch.commit();
      batch = firestorePos.batch();
    }
  }
  if (count % 400 !== 0) await batch.commit();
  console.log(`Tagged ${count} legacy VIP orders for manual review.`);
}

main().catch((error) => {
  console.error("VIP order migration failed", error);
  process.exitCode = 1;
});
