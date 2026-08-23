/**
 * Cola de acumulaciones de puntos que no pudieron llegar al ledger de Club León.
 *
 * Antes, cuando BackendCL fallaba, el POS escribía `usuariosApp.puntosActuales`
 * por su cuenta. Eso creaba un segundo saldo que el motor oficial de loyalty
 * pisaba en cuanto otra fuente (racha, ecommerce) recalculaba desde
 * `loyalty_wallets`, y los puntos del POS desaparecían.
 *
 * Ahora la venta termina igual, pero los puntos quedan como operación PENDING
 * en la base del propio POS (`puntoventacl/concesiones`, que no depende de las
 * credenciales de app-oficial) y se reintegran al ledger oficial cuando
 * BackendCL vuelve. La clave `pos-sale:<ventaId>` es la misma que usa la
 * acumulación en vivo y la reparación histórica, así que reprocesar mil veces
 * acredita una sola.
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";

export const PENDING_LOYALTY_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type PendingLoyaltyStatus =
  (typeof PENDING_LOYALTY_STATUS)[keyof typeof PENDING_LOYALTY_STATUS];

/** Tras este número de intentos deja de reintentarse solo y requiere revisión. */
export const MAX_PENDING_ATTEMPTS = 25;

export interface PendingLoyaltyAccrual {
  id: string;
  idempotencyKey: string;
  memberId: string;
  ventaId: string;
  folioVenta: string;
  puntos: number;
  total: number;
  origen: "POS";
  concesionId?: string;
  sucursalId?: string;
  cajaId?: string;
  descripcion: string;
  status: PendingLoyaltyStatus;
  attempts: number;
  lastError?: {
    status?: number;
    code?: string;
    message?: string;
    at?: Timestamp;
  };
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  completedAt?: Timestamp;
  ledgerTransactionId?: string;
  alreadyProcessed?: boolean;
}

/**
 * Namespace canónico de la venta dentro del ledger oficial. Debe coincidir
 * carácter por carácter con `buildPosSaleExternalTxnId` de BackendCL.
 */
export const buildPosSaleIdempotencyKey = (ventaId: string): string =>
  `pos-sale:${ventaId.trim().replace(/\s+/g, " ")}`;

const buildDocId = (ventaId: string): string =>
  `pos_acc_${ventaId.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120)}`;

const collection = () =>
  firestorePos.collection(COLLECTIONS.LOYALTY_OPERACIONES_PENDIENTES);

export interface EnqueueParams {
  memberId: string;
  ventaId: string;
  folioVenta?: string;
  puntos: number;
  total: number;
  descripcion: string;
  concesionId?: string;
  sucursalId?: string;
  cajaId?: string;
  error?: { status?: number; code?: string; message?: string };
}

/**
 * Registra (o actualiza) la acumulación pendiente. Es idempotente por ventaId:
 * reintentar la misma venta no crea una segunda operación ni duplica puntos,
 * solo suma un intento y refresca el último error.
 */
export const enqueuePendingAccrual = async (
  params: EnqueueParams,
): Promise<PendingLoyaltyAccrual> => {
  const ventaId = params.ventaId.trim();
  const docId = buildDocId(ventaId);
  const ref = collection().doc(docId);

  const result = await firestorePos.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists
      ? (snap.data() as PendingLoyaltyAccrual)
      : null;

    // Una venta ya integrada al ledger no vuelve a la cola por un error
    // posterior: el ledger es la fuente de verdad, no este registro.
    if (existing?.status === PENDING_LOYALTY_STATUS.COMPLETED) {
      return existing;
    }

    const attempts = (existing?.attempts ?? 0) + 1;
    const payload: Record<string, unknown> = {
      id: docId,
      idempotencyKey: buildPosSaleIdempotencyKey(ventaId),
      memberId: params.memberId.trim(),
      ventaId,
      folioVenta: (params.folioVenta ?? ventaId).trim(),
      puntos: Math.trunc(params.puntos),
      total: params.total,
      origen: "POS",
      concesionId: params.concesionId,
      sucursalId: params.sucursalId,
      cajaId: params.cajaId,
      descripcion: params.descripcion,
      status: PENDING_LOYALTY_STATUS.PENDING,
      attempts,
      lastError: params.error
        ? { ...params.error, at: Timestamp.now() }
        : existing?.lastError,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!existing) {
      payload.createdAt = FieldValue.serverTimestamp();
    }

    tx.set(ref, payload, { merge: true });
    return { ...(existing ?? {}), ...payload } as PendingLoyaltyAccrual;
  });

  return result;
};

/** Cierra la operación cuando la venta ya quedó acreditada en el ledger. */
export const markPendingAccrualCompleted = async (params: {
  ventaId: string;
  ledgerTransactionId?: string;
  alreadyProcessed?: boolean;
}): Promise<void> => {
  const ref = collection().doc(buildDocId(params.ventaId));
  const snap = await ref.get();
  if (!snap.exists) {
    return;
  }
  await ref.set(
    {
      status: PENDING_LOYALTY_STATUS.COMPLETED,
      ledgerTransactionId: params.ledgerTransactionId,
      alreadyProcessed: params.alreadyProcessed ?? false,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
};

export const markPendingAccrualFailed = async (params: {
  ventaId: string;
  attempts: number;
  error?: { status?: number; code?: string; message?: string };
}): Promise<void> => {
  const ref = collection().doc(buildDocId(params.ventaId));
  await ref.set(
    {
      status:
        params.attempts >= MAX_PENDING_ATTEMPTS
          ? PENDING_LOYALTY_STATUS.FAILED
          : PENDING_LOYALTY_STATUS.PENDING,
      attempts: params.attempts,
      lastError: params.error
        ? { ...params.error, at: Timestamp.now() }
        : undefined,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
};

export const listPendingAccruals = async (
  limit = 50,
): Promise<PendingLoyaltyAccrual[]> => {
  const snap = await collection()
    .where("status", "==", PENDING_LOYALTY_STATUS.PENDING)
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as PendingLoyaltyAccrual);
};

export const getPendingAccrual = async (
  ventaId: string,
): Promise<PendingLoyaltyAccrual | null> => {
  const snap = await collection().doc(buildDocId(ventaId)).get();
  return snap.exists ? (snap.data() as PendingLoyaltyAccrual) : null;
};

export const countPendingAccruals = async (): Promise<{
  pending: number;
  failed: number;
}> => {
  const [pending, failed] = await Promise.all([
    collection().where("status", "==", PENDING_LOYALTY_STATUS.PENDING).count().get(),
    collection().where("status", "==", PENDING_LOYALTY_STATUS.FAILED).count().get(),
  ]);
  return {
    pending: pending.data().count,
    failed: failed.data().count,
  };
};
