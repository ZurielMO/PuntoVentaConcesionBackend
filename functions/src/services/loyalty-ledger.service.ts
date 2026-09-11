/**
 * Ledger de puntos del POS.
 *
 * El saldo canónico de un socio vive en `loyalty_wallets/{socio}.availablePoints`:
 * es el que lee BackendCL para la racha, los bonos, la tienda y la app.
 * `usuariosApp.puntosActuales` es solo un espejo derivado, y BackendCL lo
 * reescribe desde el wallet en cada operación. Por eso mover únicamente el
 * espejo no acumula ni canjea nada: el siguiente bono de BackendCL lo sobre-
 * escribe con el saldo del wallet y los puntos del POS desaparecen.
 *
 * Cada operación mueve, dentro de una sola transacción:
 *   loyalty_wallets             saldo canónico (available/held/lifetime/nivel)
 *   loyalty_transactions        asiento oficial (el historial que ve la app)
 *   loyalty_external_txn_index  candado por venta, compartido con BackendCL
 *   usuariosApp                 espejo legacy (`puntosActuales` + `nivel`)
 *   movimientos_puntos          comprobante POS e idempotencia por venta
 *
 * La idempotencia es por venta y tiene dos candados: el ID del documento de
 * movimiento (`pos_acc_<ventaId>` al acumular, `pos_<ventaId>` al canjear) y,
 * para las acumulaciones, el índice externo `STORE:pos-sale:<ventaId>` que
 * también usan el adaptador de staff y los scripts de reparación de BackendCL.
 * Reintentar la misma venta —desde el POS o desde BackendCL— nunca duplica.
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type {
  DocumentReference,
  DocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";
import { firestoreApp, USUARIOS_APP_COLLECTION } from "../config/app.firebase";
import { ApiError } from "../utils/api-error";

const MOVIMIENTOS_PUNTOS_SUBCOLLECTION = "movimientos_puntos";
const LOYALTY_WALLETS_COLLECTION = "loyalty_wallets";
const LOYALTY_TRANSACTIONS_COLLECTION = "loyalty_transactions";
const LOYALTY_EXTERNAL_TXN_INDEX_COLLECTION = "loyalty_external_txn_index";

/** Canal y prefijo con los que BackendCL identifica las ventas del POS. */
const POS_SALE_CHANNEL = "STORE";
const POS_SALE_EXTERNAL_PREFIX = "pos-sale";
/** Canal que BackendCL usa en los asientos de canje, sea cual sea el origen. */
const REDEMPTION_CHANNEL = "SYSTEM";
const POS_ACTOR_ID = "pos-concesion";

const LEDGER_TIPO = {
  EARN: "EARN",
  REDEMPTION_HOLD: "REDEMPTION_HOLD",
  REDEMPTION_CONFIRM: "REDEMPTION_CONFIRM",
  REDEMPTION_RELEASE: "REDEMPTION_RELEASE",
} as const;

export const MOVIMIENTO_TIPO = {
  ACUMULACION: "ACUMULACION",
  CANJE: "CANJE",
} as const;

export const CANJE_ESTADO = {
  HELD: "HELD",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
} as const;

export type CanjeEstado = (typeof CANJE_ESTADO)[keyof typeof CANJE_ESTADO];

export type AccrualStatus = "APPLIED" | "ALREADY_PROCESSED";

export interface AccrueSalePointsResult {
  memberId: string;
  status: AccrualStatus;
  puntosAsignados: number;
  saldoAnterior: number;
  puntosActuales: number;
  movimientoId: string;
}

export interface HoldSalePointsResult {
  redemptionId: string;
  memberId: string;
  puntosCanjeados: number;
  descripcion: string;
  saldoAnterior: number;
  puntosActuales: number;
  alreadyHeld: boolean;
}

export interface ConfirmSalePointsResult {
  redemptionId: string;
  memberId: string;
  puntosCanjeados: number;
  puntosActuales: number;
  descripcion: string;
  alreadyConfirmed: boolean;
}

export interface UsuarioAppRef {
  ref: DocumentReference;
  id: string;
  data: Record<string, unknown>;
}

const sanitizeDocId = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);

export const buildAccrualMovementId = (ventaId: string): string =>
  `pos_acc_${sanitizeDocId(ventaId)}`;

export const buildRedemptionMovementId = (ventaId: string): string =>
  `pos_${sanitizeDocId(ventaId)}`;

/** Misma clave que genera BackendCL para una venta del POS. */
export const buildPosSaleExternalTxnId = (ventaId: string): string =>
  `${POS_SALE_EXTERNAL_PREFIX}:${ventaId.trim().replace(/\s+/g, " ")}`;

const buildExternalTxnKey = (externalTransactionId: string): string =>
  `${POS_SALE_CHANNEL}:${externalTransactionId}`;

const toPuntos = (value: unknown): number => {
  const parsed = Math.trunc(Number(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Espejo de `conversionRulesService.calculateLevel` de BackendCL. El nivel se
 * persiste junto al saldo, así que si allá se mueven los cortes hay que
 * moverlos aquí o el wallet y el espejo quedarían con niveles distintos.
 */
const calcularNivel = (puntos: number): string => {
  const p = Math.max(0, Math.trunc(puntos));
  if (p >= 1050) return "Esmeralda";
  if (p >= 750) return "Diamante";
  if (p >= 450) return "Platino";
  if (p >= 300) return "Oro";
  if (p >= 150) return "Plata";
  return "Bronce";
};

interface WalletState {
  availablePoints: number;
  heldPoints: number;
  pendingPoints: number;
  lifetimeEarnedPoints: number;
  lifetimeRedeemedPoints: number;
  nextExpirationAt?: unknown;
  createdAt?: unknown;
}

/**
 * El socio puede estar guardado con el UID como ID de documento o con el UID
 * en el campo `uid`. La query se hace fuera de la transacción porque solo sirve
 * para ubicar el documento; el saldo siempre se lee dentro de ella.
 */
export const resolveUsuarioAppRef = async (
  memberId: string,
): Promise<UsuarioAppRef | null> => {
  const trimmed = memberId.trim();
  if (!trimmed) {
    return null;
  }

  const collection = firestoreApp.collection(USUARIOS_APP_COLLECTION);

  const directRef = collection.doc(trimmed);
  const directSnap = await directRef.get();
  if (directSnap.exists) {
    return {
      ref: directRef,
      id: directSnap.id,
      data: (directSnap.data() ?? {}) as Record<string, unknown>,
    };
  }

  const snapshot = await collection.where("uid", "==", trimmed).limit(1).get();
  if (snapshot.empty) {
    return null;
  }

  const snap = snapshot.docs[0];
  return {
    ref: snap.ref,
    id: snap.id,
    data: (snap.data() ?? {}) as Record<string, unknown>,
  };
};

const requireUsuarioAppRef = async (
  memberId: string,
): Promise<UsuarioAppRef> => {
  const usuario = await resolveUsuarioAppRef(memberId);
  if (!usuario) {
    throw new ApiError(404, "Socio no encontrado", true, "MEMBER_NOT_FOUND");
  }
  return usuario;
};

/**
 * BackendCL indexa el wallet y el ledger por el ID del documento de
 * `usuariosApp`, así que el POS tiene que usar exactamente esa clave para
 * escribir sobre el mismo saldo y no crear un wallet paralelo.
 */
const walletRefFor = (memberDocId: string): DocumentReference =>
  firestoreApp.collection(LOYALTY_WALLETS_COLLECTION).doc(memberDocId);

/**
 * Saldo gastable del socio. Sale del wallet porque es el mismo que va a usar
 * el canje del POS y cualquier operación de BackendCL; el espejo legacy solo
 * se consulta mientras el socio todavía no tenga wallet.
 */
export const readAvailablePoints = async (
  usuario: UsuarioAppRef,
): Promise<number> => {
  const walletSnap = await walletRefFor(usuario.id).get();
  if (walletSnap.exists) {
    return toPuntos(walletSnap.data()?.availablePoints);
  }
  return Math.max(0, toPuntos(usuario.data.puntosActuales));
};

/**
 * Lee el saldo canónico. Si el socio todavía no tiene wallet lo inicializa
 * desde `puntosActuales`: es el único momento en que el espejo legacy manda,
 * porque es el saldo con el que el socio venía antes de existir el wallet.
 * Es la misma inicialización que hace `executeMutation` en BackendCL.
 */
const readWalletInTx = (
  walletSnap: DocumentSnapshot,
  userSnap: DocumentSnapshot,
): WalletState => {
  if (!walletSnap.exists) {
    const legacy = Math.max(0, toPuntos(userSnap.data()?.puntosActuales));
    return {
      availablePoints: legacy,
      heldPoints: 0,
      pendingPoints: 0,
      lifetimeEarnedPoints: legacy,
      lifetimeRedeemedPoints: 0,
      nextExpirationAt: (
        userSnap.data()?.historialPuntos as
          | { proximaExpiracionProgramada?: unknown }
          | undefined
      )?.proximaExpiracionProgramada,
      createdAt: userSnap.data()?.createdAt,
    };
  }

  const data = walletSnap.data() ?? {};
  return {
    availablePoints: toPuntos(data.availablePoints),
    heldPoints: toPuntos(data.heldPoints),
    pendingPoints: toPuntos(data.pendingPoints),
    lifetimeEarnedPoints: toPuntos(data.lifetimeEarnedPoints),
    lifetimeRedeemedPoints: toPuntos(data.lifetimeRedeemedPoints),
    nextExpirationAt: data.nextExpirationAt,
    createdAt: data.createdAt,
  };
};

/**
 * Persiste el saldo canónico y su espejo. Los dos salen del mismo cálculo, así
 * que no pueden divergir: el espejo nunca se escribe por separado.
 */
const applyWalletDeltaInTx = (
  tx: Transaction,
  params: {
    memberDocId: string;
    userRef: DocumentReference;
    wallet: WalletState;
    availableDelta: number;
    heldDelta?: number;
    lifetimeEarnedDelta?: number;
    lifetimeRedeemedDelta?: number;
  },
): { availablePoints: number; level: string } => {
  const availablePoints = params.wallet.availablePoints + params.availableDelta;
  const heldPoints = params.wallet.heldPoints + (params.heldDelta ?? 0);

  if (availablePoints < 0 || heldPoints < 0) {
    throw new ApiError(
      400,
      "Puntos insuficientes",
      true,
      "INSUFFICIENT_POINTS",
    );
  }

  const level = calcularNivel(availablePoints);
  const now = Timestamp.now();

  tx.set(
    walletRefFor(params.memberDocId),
    {
      memberId: params.memberDocId,
      availablePoints,
      heldPoints,
      pendingPoints: params.wallet.pendingPoints,
      lifetimeEarnedPoints:
        params.wallet.lifetimeEarnedPoints + (params.lifetimeEarnedDelta ?? 0),
      lifetimeRedeemedPoints:
        params.wallet.lifetimeRedeemedPoints +
        (params.lifetimeRedeemedDelta ?? 0),
      level,
      nextExpirationAt: params.wallet.nextExpirationAt,
      createdAt: params.wallet.createdAt ?? now,
      updatedAt: now,
    },
    { merge: true },
  );

  tx.set(
    params.userRef,
    {
      puntosActuales: availablePoints,
      nivel: level,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { availablePoints, level };
};

/** Asiento en el ledger oficial: es el historial que la app le muestra al socio. */
const appendLedgerEntryInTx = (
  tx: Transaction,
  params: {
    memberDocId: string;
    type: string;
    channel: string;
    points: number;
    balanceBefore: number;
    balanceAfter: number;
    descripcion: string;
    ventaId: string;
    externalTransactionId?: string;
    amountCents?: number;
    reasonCode?: string;
  },
): string => {
  const txnRef = firestoreApp
    .collection(LOYALTY_TRANSACTIONS_COLLECTION)
    .doc();

  tx.set(txnRef, {
    transactionId: txnRef.id,
    memberId: params.memberDocId,
    actorId: POS_ACTOR_ID,
    actorType: "SERVICE",
    type: params.type,
    status: "CONFIRMED",
    points: params.points,
    balanceBefore: params.balanceBefore,
    balanceAfter: params.balanceAfter,
    channel: params.channel,
    currency: "MXN",
    amountCents: params.amountCents,
    externalTransactionId: params.externalTransactionId,
    description: params.descripcion,
    reasonCode: params.reasonCode,
    metadata: {
      source: "POS",
      origen: "pos-concesion",
      ventaId: params.ventaId,
      saleId: params.ventaId,
    },
    createdAt: Timestamp.now(),
  });

  return txnRef.id;
};

export const accrueSalePoints = async (params: {
  memberId: string;
  ventaId: string;
  puntos: number;
  descripcion: string;
  montoVenta?: number;
}): Promise<AccrueSalePointsResult> => {
  const memberId = params.memberId.trim();
  const ventaId = params.ventaId.trim();
  const puntos = Math.trunc(params.puntos);

  if (!Number.isFinite(puntos) || puntos <= 0) {
    throw new ApiError(400, "Cantidad de puntos inválida", true, "INVALID_POINTS");
  }

  const usuario = await requireUsuarioAppRef(memberId);
  const movimientoId = buildAccrualMovementId(ventaId);
  const movRef = usuario.ref
    .collection(MOVIMIENTOS_PUNTOS_SUBCOLLECTION)
    .doc(movimientoId);
  const externalTransactionId = buildPosSaleExternalTxnId(ventaId);
  const extRef = firestoreApp
    .collection(LOYALTY_EXTERNAL_TXN_INDEX_COLLECTION)
    .doc(buildExternalTxnKey(externalTransactionId));
  const walletRef = walletRefFor(usuario.id);

  const montoVenta = Number(params.montoVenta);
  const amountCents =
    Number.isFinite(montoVenta) && montoVenta > 0
      ? Math.round(montoVenta * 100)
      : undefined;

  return firestoreApp.runTransaction(async (tx) => {
    const [userSnap, movSnap, walletSnap, extSnap] = await Promise.all([
      tx.get(usuario.ref),
      tx.get(movRef),
      tx.get(walletRef),
      tx.get(extRef),
    ]);

    if (!userSnap.exists) {
      throw new ApiError(404, "Socio no encontrado", true, "MEMBER_NOT_FOUND");
    }

    const wallet = readWalletInTx(walletSnap, userSnap);
    const saldoActual = wallet.availablePoints;

    // El índice externo lo comparten el POS, el QR de staff y los scripts de
    // reparación: si la venta ya se acreditó por cualquiera de esos caminos,
    // volver a sumarla aquí duplicaría los puntos.
    if (movSnap.exists || extSnap.exists) {
      const previo = movSnap.data() ?? {};
      return {
        memberId,
        status: "ALREADY_PROCESSED" as const,
        puntosAsignados: Math.abs(toPuntos(previo.puntos)) || puntos,
        saldoAnterior: toPuntos(previo.saldoAnterior),
        puntosActuales: saldoActual,
        movimientoId,
      };
    }

    const { availablePoints: saldoNuevo } = applyWalletDeltaInTx(tx, {
      memberDocId: usuario.id,
      userRef: usuario.ref,
      wallet,
      availableDelta: puntos,
      lifetimeEarnedDelta: puntos,
    });

    const transactionId = appendLedgerEntryInTx(tx, {
      memberDocId: usuario.id,
      type: LEDGER_TIPO.EARN,
      channel: POS_SALE_CHANNEL,
      points: puntos,
      balanceBefore: saldoActual,
      balanceAfter: saldoNuevo,
      descripcion: params.descripcion,
      ventaId,
      externalTransactionId,
      amountCents,
    });

    tx.set(extRef, {
      transactionId,
      memberId: usuario.id,
      channel: POS_SALE_CHANNEL,
    });

    tx.set(movRef, {
      id: movimientoId,
      usuarioId: usuario.id,
      tipo: MOVIMIENTO_TIPO.ACUMULACION,
      puntos,
      saldoAnterior: saldoActual,
      saldoNuevo,
      origen: "pos",
      origenId: ventaId,
      referencia: ventaId,
      descripcion: params.descripcion,
      transactionId,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      memberId,
      status: "APPLIED" as const,
      puntosAsignados: puntos,
      saldoAnterior: saldoActual,
      puntosActuales: saldoNuevo,
      movimientoId,
    };
  });
};

/**
 * Reserva los puntos del canje descontándolos de inmediato. Se debita aquí y no
 * al confirmar para que dos cajas no puedan gastar el mismo saldo mientras la
 * venta se registra; si la venta falla, `cancelSalePointsHold` los reintegra.
 *
 * Igual que en BackendCL, los puntos pasan de `availablePoints` a `heldPoints`:
 * salen del saldo gastable pero siguen contabilizados hasta que la venta se
 * confirma o se cancela.
 */
export const holdSalePoints = async (params: {
  memberId: string;
  ventaId: string;
  puntos: number;
  descripcion: string;
}): Promise<HoldSalePointsResult> => {
  const memberId = params.memberId.trim();
  const ventaId = params.ventaId.trim();
  const puntos = Math.trunc(params.puntos);

  if (!Number.isFinite(puntos) || puntos <= 0) {
    throw new ApiError(400, "Cantidad de puntos inválida", true, "INVALID_POINTS");
  }

  const usuario = await requireUsuarioAppRef(memberId);
  const redemptionId = buildRedemptionMovementId(ventaId);
  const movRef = usuario.ref
    .collection(MOVIMIENTOS_PUNTOS_SUBCOLLECTION)
    .doc(redemptionId);
  const walletRef = walletRefFor(usuario.id);

  return firestoreApp.runTransaction(async (tx) => {
    const [userSnap, movSnap, walletSnap] = await Promise.all([
      tx.get(usuario.ref),
      tx.get(movRef),
      tx.get(walletRef),
    ]);

    if (!userSnap.exists) {
      throw new ApiError(404, "Socio no encontrado", true, "MEMBER_NOT_FOUND");
    }

    const wallet = readWalletInTx(walletSnap, userSnap);
    const saldoActual = wallet.availablePoints;

    if (movSnap.exists) {
      const previo = movSnap.data() ?? {};
      const estado = String(previo.estado ?? "") as CanjeEstado;
      // Una reserva viva de la misma venta ya descontó el saldo: devolverla tal
      // cual evita cobrar los puntos dos veces por un reintento.
      if (estado === CANJE_ESTADO.HELD || estado === CANJE_ESTADO.CONFIRMED) {
        return {
          redemptionId,
          memberId,
          puntosCanjeados: Math.abs(toPuntos(previo.puntos)) || puntos,
          descripcion: String(previo.descripcion ?? params.descripcion),
          saldoAnterior: toPuntos(previo.saldoAnterior),
          puntosActuales: saldoActual,
          alreadyHeld: true,
        };
      }
    }

    if (saldoActual < puntos) {
      throw new ApiError(
        400,
        `Puntos insuficientes: el socio tiene ${saldoActual} y se requieren ${puntos}`,
        true,
        "INSUFFICIENT_POINTS",
      );
    }

    const { availablePoints: saldoNuevo } = applyWalletDeltaInTx(tx, {
      memberDocId: usuario.id,
      userRef: usuario.ref,
      wallet,
      availableDelta: -puntos,
      heldDelta: puntos,
    });

    const transactionId = appendLedgerEntryInTx(tx, {
      memberDocId: usuario.id,
      type: LEDGER_TIPO.REDEMPTION_HOLD,
      channel: REDEMPTION_CHANNEL,
      points: -puntos,
      balanceBefore: saldoActual,
      balanceAfter: saldoNuevo,
      descripcion: params.descripcion,
      ventaId,
    });

    tx.set(movRef, {
      id: redemptionId,
      usuarioId: usuario.id,
      tipo: MOVIMIENTO_TIPO.CANJE,
      puntos: -puntos,
      saldoAnterior: saldoActual,
      saldoNuevo,
      estado: CANJE_ESTADO.HELD,
      origen: "pos",
      origenId: ventaId,
      referencia: ventaId,
      descripcion: params.descripcion,
      transactionId,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      redemptionId,
      memberId,
      puntosCanjeados: puntos,
      descripcion: params.descripcion,
      saldoAnterior: saldoActual,
      puntosActuales: saldoNuevo,
      alreadyHeld: false,
    };
  });
};

/**
 * Cierra la reserva: los puntos salen de `heldPoints` y pasan al acumulado
 * histórico de canjes. El saldo gastable no se mueve porque ya se descontó al
 * reservar.
 */
export const confirmSalePointsHold = async (params: {
  redemptionId: string;
  memberId: string;
  ventaId: string;
}): Promise<ConfirmSalePointsResult> => {
  const memberId = params.memberId.trim();
  const usuario = await requireUsuarioAppRef(memberId);
  const movRef = usuario.ref
    .collection(MOVIMIENTOS_PUNTOS_SUBCOLLECTION)
    .doc(params.redemptionId);
  const walletRef = walletRefFor(usuario.id);

  return firestoreApp.runTransaction(async (tx) => {
    const [userSnap, movSnap, walletSnap] = await Promise.all([
      tx.get(usuario.ref),
      tx.get(movRef),
      tx.get(walletRef),
    ]);

    if (!movSnap.exists) {
      throw new ApiError(
        404,
        "No se encontró la reserva de puntos de la venta",
        true,
        "REDEMPTION_NOT_FOUND",
      );
    }

    const movimiento = movSnap.data() ?? {};
    const estado = String(movimiento.estado ?? "") as CanjeEstado;
    const puntosCanjeados = Math.abs(toPuntos(movimiento.puntos));
    const wallet = readWalletInTx(walletSnap, userSnap);
    const saldoActual = wallet.availablePoints;
    const descripcion = String(movimiento.descripcion ?? `Canje POS ${params.ventaId}`);

    if (estado === CANJE_ESTADO.CANCELLED) {
      throw new ApiError(
        409,
        "La reserva de puntos ya fue cancelada",
        true,
        "REDEMPTION_CANCELLED",
      );
    }

    if (estado === CANJE_ESTADO.CONFIRMED) {
      return {
        redemptionId: params.redemptionId,
        memberId,
        puntosCanjeados,
        puntosActuales: saldoActual,
        descripcion,
        alreadyConfirmed: true,
      };
    }

    applyWalletDeltaInTx(tx, {
      memberDocId: usuario.id,
      userRef: usuario.ref,
      wallet,
      availableDelta: 0,
      heldDelta: -puntosCanjeados,
      lifetimeRedeemedDelta: puntosCanjeados,
    });

    const transactionId = appendLedgerEntryInTx(tx, {
      memberDocId: usuario.id,
      type: LEDGER_TIPO.REDEMPTION_CONFIRM,
      channel: REDEMPTION_CHANNEL,
      points: -puntosCanjeados,
      balanceBefore: saldoActual,
      balanceAfter: saldoActual,
      descripcion,
      ventaId: params.ventaId,
    });

    tx.update(movRef, {
      estado: CANJE_ESTADO.CONFIRMED,
      confirmTransactionId: transactionId,
      confirmedAt: FieldValue.serverTimestamp(),
    });

    return {
      redemptionId: params.redemptionId,
      memberId,
      puntosCanjeados,
      puntosActuales: saldoActual,
      descripcion,
      alreadyConfirmed: false,
    };
  });
};

/**
 * Devuelve los puntos de una reserva que nunca llegó a confirmarse. Best-effort
 * a propósito: se invoca cuando la venta ya falló y no debe enmascarar el error
 * original que se le va a mostrar al cajero.
 */
export const cancelSalePointsHold = async (params: {
  redemptionId: string;
  memberId: string;
  ventaId: string;
}): Promise<void> => {
  try {
    const usuario = await resolveUsuarioAppRef(params.memberId);
    if (!usuario) {
      return;
    }

    const movRef = usuario.ref
      .collection(MOVIMIENTOS_PUNTOS_SUBCOLLECTION)
      .doc(params.redemptionId);
    const walletRef = walletRefFor(usuario.id);

    await firestoreApp.runTransaction(async (tx) => {
      const [userSnap, movSnap, walletSnap] = await Promise.all([
        tx.get(usuario.ref),
        tx.get(movRef),
        tx.get(walletRef),
      ]);

      if (!movSnap.exists || !userSnap.exists) {
        return;
      }

      const movimiento = movSnap.data() ?? {};
      const estado = String(movimiento.estado ?? "") as CanjeEstado;
      if (estado !== CANJE_ESTADO.HELD) {
        return;
      }

      const puntos = Math.abs(toPuntos(movimiento.puntos));
      const wallet = readWalletInTx(walletSnap, userSnap);
      const saldoActual = wallet.availablePoints;

      const { availablePoints: saldoNuevo } = applyWalletDeltaInTx(tx, {
        memberDocId: usuario.id,
        userRef: usuario.ref,
        wallet,
        availableDelta: puntos,
        heldDelta: -puntos,
      });

      const transactionId = appendLedgerEntryInTx(tx, {
        memberDocId: usuario.id,
        type: LEDGER_TIPO.REDEMPTION_RELEASE,
        channel: REDEMPTION_CHANNEL,
        points: puntos,
        balanceBefore: saldoActual,
        balanceAfter: saldoNuevo,
        descripcion: `Liberación de canje POS ${params.ventaId}`,
        ventaId: params.ventaId,
      });

      tx.update(movRef, {
        estado: CANJE_ESTADO.CANCELLED,
        cancelledAt: FieldValue.serverTimestamp(),
        releaseTransactionId: transactionId,
        saldoNuevo,
      });
    });
  } catch (error) {
    console.error("[loyalty] no se pudo cancelar la reserva de puntos", {
      ventaId: params.ventaId,
      redemptionId: params.redemptionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
