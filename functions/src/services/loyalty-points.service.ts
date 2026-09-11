/**
 * Reglas de negocio de los puntos del POS.
 *
 * El saldo y el historial son los de Club León (`loyalty_wallets` y
 * `loyalty_transactions`) y se mueven a través de `loyalty-ledger.service`, que
 * garantiza atomicidad e idempotencia por venta y comparte el ledger con
 * BackendCL. Este módulo aporta el cálculo (10% al acumular, 10 puntos = $1 al
 * canjear) y la forma de las respuestas que consumen controladores y ventas.
 */
import { ApiError } from "../utils/api-error";
import {
  accrueSalePoints,
  cancelSalePointsHold,
  confirmSalePointsHold,
  holdSalePoints,
  readAvailablePoints,
  resolveUsuarioAppRef,
} from "./loyalty-ledger.service";
import {
  buildPosSaleIdempotencyKey,
  listPendingAccruals,
  markPendingAccrualCompleted,
  markPendingAccrualFailed,
} from "./loyalty-outbox.service";

export interface ClubMemberData {
  id: string;
  nombre: string;
  email: string;
  puntosActuales: number;
}

/**
 * `APPLIED`           la venta acaba de entrar al ledger.
 * `ALREADY_PROCESSED` ya estaba en el ledger; no se movió ningún saldo.
 * `PENDING`           reservado para las acumulaciones que quedaron en la cola.
 */
export type AssignPointsBySaleStatus =
  | "APPLIED"
  | "ALREADY_PROCESSED"
  | "PENDING";

export interface AssignPointsBySaleResult {
  memberId: string;
  montoVenta: number;
  puntosAsignados: number;
  puntosActuales: number;
  descripcion: string;
  status: AssignPointsBySaleStatus;
  alreadyProcessed: boolean;
  externalTransactionId: string;
  externalResponse: unknown;
}

export interface RedeemPointsBySaleResult {
  memberId: string;
  puntosCanjeados: number;
  montoPuntos: number;
  puntosActuales: number;
  descripcion: string;
  redemptionId: string;
  externalResponse: unknown;
}

/** 10 puntos = $1 MXN al canjear en POS (inverso del 10% de acumulación). */
export const PUNTOS_POR_PESO_CANJE = 10;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

/**
 * Canje always uses whole pesos only: floor points to multiples of
 * PUNTOS_POR_PESO_CANJE (183 → 180 pts → $18; leave 3 unused).
 */
export const puntosUsablesParaCanje = (puntos: number): number => {
  const truncados = Math.max(0, Math.trunc(puntos));
  return Math.floor(truncados / PUNTOS_POR_PESO_CANJE) * PUNTOS_POR_PESO_CANJE;
};

/** Money from points; only complete-peso multiples count (183 → 18). */
export const calcularMontoDesdePuntos = (puntos: number): number =>
  puntosUsablesParaCanje(puntos) / PUNTOS_POR_PESO_CANJE;

/** Max points redeemable toward total, capped at whole pesos (floor). */
export const calcularPuntosNecesariosParaTotal = (total: number): number => {
  const pesosEnteros = Math.max(0, Math.floor(Number(total) || 0));
  return pesosEnteros * PUNTOS_POR_PESO_CANJE;
};

export const calcularCanjePuntos = (params: {
  total: number;
  puntosDisponibles: number;
  puntosSolicitados?: number;
}): { puntosUsados: number; montoPuntos: number; restante: number } => {
  const { total, puntosDisponibles } = params;
  const maxPuntos = calcularPuntosNecesariosParaTotal(total);
  const disponiblesUsables = puntosUsablesParaCanje(puntosDisponibles);
  const solicitadosUsables =
    params.puntosSolicitados == null
      ? maxPuntos
      : puntosUsablesParaCanje(params.puntosSolicitados);
  const puntosUsados = Math.min(solicitadosUsables, disponiblesUsables, maxPuntos);
  const montoPuntos = calcularMontoDesdePuntos(puntosUsados);
  const restante = roundMoney(Math.max(0, total - montoPuntos));
  return { puntosUsados, montoPuntos, restante };
};

export const calcularPuntosPorVenta = (total: number): number =>
  Math.round(total * 0.1);

/**
 * True when the sale should earn loyalty points.
 * Any points redemption (puntos / puntos+efectivo / puntos+tarjeta) earns 0.
 */
export const ventaAcumulaPuntos = (params: {
  metodoPago?: string | null;
  puntosUsados?: number | null;
}): boolean => {
  const puntosUsados = Math.max(0, Math.trunc(Number(params.puntosUsados) || 0));
  const metodo = String(params.metodoPago ?? "").trim().toLowerCase();
  if (puntosUsados > 0) return false;
  if (metodo === "puntos" || metodo.startsWith("puntos+")) return false;
  return true;
};

const memberFromUsuariosApp = (
  id: string,
  data: Record<string, unknown>,
  fallbackId: string,
  puntosActuales: number,
): ClubMemberData => {
  const nombre =
    (data.nombre as string | undefined)?.trim() ||
    (data.displayName as string | undefined)?.trim() ||
    "Socio";
  const email = (data.email as string | undefined)?.trim() ?? "";

  return {
    id: (data.uid as string | undefined)?.trim() || id || fallbackId,
    nombre,
    email,
    puntosActuales: Number.isFinite(puntosActuales) ? puntosActuales : 0,
  };
};

export const getClubMember = async (memberId: string): Promise<ClubMemberData> => {
  const trimmedId = memberId.trim();
  if (!trimmedId) {
    throw new ApiError(400, "ID de socio inválido", true, "INVALID_MEMBER_ID");
  }

  const usuario = await resolveUsuarioAppRef(trimmedId);
  if (!usuario) {
    throw new ApiError(404, "Socio no encontrado", true, "MEMBER_NOT_FOUND");
  }

  return memberFromUsuariosApp(
    usuario.id,
    usuario.data,
    trimmedId,
    await readAvailablePoints(usuario),
  );
};

export const redeemPointsBySale = async (params: {
  memberId: string;
  puntos: number;
  ventaId: string;
}): Promise<RedeemPointsBySaleResult> => {
  const hold = await createRedemptionHold(params);
  try {
    return await confirmRedemptionHold({
      redemptionId: hold.redemptionId,
      ventaId: params.ventaId,
      memberId: hold.memberId,
      puntosCanjeados: hold.puntosCanjeados,
      descripcion: hold.descripcion,
    });
  } catch (error) {
    await cancelRedemptionHold({
      redemptionId: hold.redemptionId,
      ventaId: params.ventaId,
      memberId: hold.memberId,
    });
    throw error;
  }
};

export const createRedemptionHold = async (params: {
  memberId: string;
  puntos: number;
  ventaId: string;
}): Promise<{
  redemptionId: string;
  memberId: string;
  puntosCanjeados: number;
  descripcion: string;
}> => {
  const { memberId, puntos, ventaId } = params;
  const trimmedId = memberId.trim();
  const puntosCanjeados = Math.trunc(puntos);

  if (!trimmedId) {
    throw new ApiError(400, "ID de socio inválido", true, "INVALID_MEMBER_ID");
  }
  if (!Number.isFinite(puntosCanjeados) || puntosCanjeados <= 0) {
    throw new ApiError(
      400,
      "Cantidad de puntos inválida",
      true,
      "INVALID_POINTS",
    );
  }

  const hold = await holdSalePoints({
    memberId: trimmedId,
    ventaId,
    puntos: puntosCanjeados,
    descripcion: `Canje POS ${ventaId}`,
  });

  return {
    redemptionId: hold.redemptionId,
    memberId: hold.memberId,
    puntosCanjeados: hold.puntosCanjeados,
    descripcion: hold.descripcion,
  };
};

export const confirmRedemptionHold = async (params: {
  redemptionId: string;
  ventaId: string;
  memberId: string;
  puntosCanjeados: number;
  descripcion: string;
}): Promise<RedeemPointsBySaleResult> => {
  const confirmed = await confirmSalePointsHold({
    redemptionId: params.redemptionId,
    memberId: params.memberId,
    ventaId: params.ventaId,
  });

  return {
    memberId: params.memberId,
    puntosCanjeados: params.puntosCanjeados,
    montoPuntos: calcularMontoDesdePuntos(params.puntosCanjeados),
    puntosActuales: confirmed.puntosActuales,
    descripcion: params.descripcion,
    redemptionId: params.redemptionId,
    externalResponse: {
      source: "pos-ledger",
      alreadyConfirmed: confirmed.alreadyConfirmed,
    },
  };
};

export const cancelRedemptionHold = async (params: {
  redemptionId: string;
  ventaId: string;
  memberId: string;
}): Promise<void> => {
  await cancelSalePointsHold({
    redemptionId: params.redemptionId,
    memberId: params.memberId,
    ventaId: params.ventaId,
  });
};

const describeError = (
  error: unknown,
): { status?: number; code?: string; message?: string } => {
  if (error instanceof ApiError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
};

/**
 * Acredita la venta en el ledger.
 *
 * La clave `pos-sale:<ventaId>` viaja en la respuesta para que el reproceso de
 * la cola y cualquier reparación histórica compartan la misma referencia; la
 * idempotencia real la impone el movimiento `pos_acc_<ventaId>` del ledger, así
 * que reintentar la misma venta nunca duplica puntos.
 */
export const assignPointsBySale = async (params: {
  memberId: string;
  total: number;
  ventaId: string;
  folioVenta?: string;
  descripcion?: string;
  concesionId?: string;
  sucursalId?: string;
  cajaId?: string;
}): Promise<AssignPointsBySaleResult> => {
  const { memberId, total, ventaId } = params;
  const trimmedId = memberId.trim();

  if (!trimmedId) {
    throw new ApiError(400, "ID de socio inválido", true, "INVALID_MEMBER_ID");
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new ApiError(400, "Total de venta inválido", true, "INVALID_TOTAL");
  }

  const puntosAsignados = calcularPuntosPorVenta(total);
  const descripcion = params.descripcion?.trim() || `Venta POS ${ventaId}`;

  const result = await accrueSalePoints({
    memberId: trimmedId,
    ventaId,
    puntos: puntosAsignados,
    descripcion,
    montoVenta: total,
  });

  // Si esta venta venía arrastrando un pendiente de la cola, ya quedó saldada.
  await markPendingAccrualCompleted({
    ventaId,
    alreadyProcessed: result.status === "ALREADY_PROCESSED",
  }).catch(() => undefined);

  return {
    memberId: trimmedId,
    montoVenta: total,
    puntosAsignados: result.puntosAsignados,
    puntosActuales: result.puntosActuales,
    descripcion,
    status: result.status,
    alreadyProcessed: result.status === "ALREADY_PROCESSED",
    externalTransactionId: buildPosSaleIdempotencyKey(ventaId),
    externalResponse: {
      source: "pos-ledger",
      movimientoId: result.movimientoId,
      saldoAnterior: result.saldoAnterior,
    },
  };
};

/**
 * Acredita las acumulaciones que quedaron encoladas cuando los puntos aún
 * dependían de un servicio externo. Idempotente: una venta ya acreditada
 * responde ALREADY_PROCESSED y no suma de nuevo.
 */
export const reprocessPendingAccruals = async (
  limit = 50,
): Promise<{
  procesadas: number;
  completadas: number;
  yaProcesadas: number;
  fallidas: number;
  detalles: Array<{
    ventaId: string;
    memberId: string;
    puntos: number;
    resultado: string;
    error?: string;
  }>;
}> => {
  const pendientes = await listPendingAccruals(limit);
  const detalles: Array<{
    ventaId: string;
    memberId: string;
    puntos: number;
    resultado: string;
    error?: string;
  }> = [];

  let completadas = 0;
  let yaProcesadas = 0;
  let fallidas = 0;

  for (const pendiente of pendientes) {
    try {
      const result = await accrueSalePoints({
        memberId: pendiente.memberId,
        ventaId: pendiente.ventaId,
        puntos: pendiente.puntos,
        descripcion: pendiente.descripcion,
        montoVenta: pendiente.total,
      });

      const alreadyProcessed = result.status === "ALREADY_PROCESSED";

      await markPendingAccrualCompleted({
        ventaId: pendiente.ventaId,
        alreadyProcessed,
      });

      if (alreadyProcessed) {
        yaProcesadas += 1;
      } else {
        completadas += 1;
      }
      detalles.push({
        ventaId: pendiente.ventaId,
        memberId: pendiente.memberId,
        puntos: pendiente.puntos,
        resultado: result.status,
      });
    } catch (error) {
      const detail = describeError(error);
      fallidas += 1;
      await markPendingAccrualFailed({
        ventaId: pendiente.ventaId,
        attempts: (pendiente.attempts ?? 0) + 1,
        error: detail,
      });
      detalles.push({
        ventaId: pendiente.ventaId,
        memberId: pendiente.memberId,
        puntos: pendiente.puntos,
        resultado: "FAILED",
        error: `${detail.status ?? ""} ${detail.code ?? ""} ${detail.message ?? ""}`.trim(),
      });
    }
  }

  return {
    procesadas: pendientes.length,
    completadas,
    yaProcesadas,
    fallidas,
    detalles,
  };
};
