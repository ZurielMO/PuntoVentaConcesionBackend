import axios from "axios";
import { FieldValue } from "firebase-admin/firestore";
import { firestoreApp } from "../config/app.firebase";
import {
  buildBackendClApiUrl,
  getBackendClBearerToken,
  invalidateBackendClAuthCache,
} from "./backendcl-auth.service";
import { ApiError } from "../utils/api-error";
import {
  buildPosSaleIdempotencyKey,
  enqueuePendingAccrual,
  listPendingAccruals,
  markPendingAccrualCompleted,
  markPendingAccrualFailed,
} from "./loyalty-outbox.service";

const USUARIOS_APP_COLLECTION = "usuariosApp";
const MOVIMIENTOS_PUNTOS_SUBCOLLECTION = "movimientos_puntos";

export interface ClubMemberData {
  id: string;
  nombre: string;
  email: string;
  puntosActuales: number;
}

/**
 * `APPLIED`           la venta acaba de entrar al ledger oficial.
 * `ALREADY_PROCESSED` ya estaba en el ledger; no se movió ningún saldo.
 * `PENDING`           BackendCL no respondió; quedó encolada para reproceso.
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

const backendClHeaders = async () => ({
  Authorization: `Bearer ${await getBackendClBearerToken()}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

const mapAxiosError = (error: unknown, fallbackMessage: string): ApiError => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | { message?: string; code?: string; detail?: string; title?: string }
      | undefined;
    const problemCode = data?.code;
    const message =
      data?.detail ?? data?.message ?? data?.title ?? fallbackMessage;

    if (status === 401) {
      return new ApiError(
        502,
        "Token de BackendCL inválido o expirado",
        true,
        "BACKENDCL_AUTH_FAILED",
      );
    }
    if (
      status === 403 ||
      problemCode === "FORBIDDEN" ||
      problemCode === "INVALID_SCOPE"
    ) {
      return new ApiError(
        502,
        "La cuenta BackendCL no tiene permisos para operaciones de puntos (requiere rol EMPLEADO, CONCESION_VENDEDOR o ADMIN en Club León)",
        true,
        "BACKENDCL_FORBIDDEN",
      );
    }
    if (status === 404) {
      return new ApiError(404, "Socio no encontrado", true, "MEMBER_NOT_FOUND");
    }
    if (status != null && status >= 400 && status < 500) {
      return new ApiError(status, message, true, "BACKENDCL_CLIENT_ERROR");
    }
  }

  return new ApiError(502, fallbackMessage, true, "BACKENDCL_UNAVAILABLE");
};

const withBackendClAuthRetry = async <T>(
  request: (headers: Record<string, string>) => Promise<T>,
): Promise<T> => {
  const buildHeaders = async () => ({
    ...(await backendClHeaders()),
  });

  try {
    return await request(await buildHeaders());
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !process.env.BACKENDCL_BEARER_TOKEN?.trim()
    ) {
      invalidateBackendClAuthCache();
      return request(await buildHeaders());
    }
    throw error;
  }
};

const DEFAULT_LOYALTY_BASE_PATH = "/api/loyalty/internal/v1";
const PARTNER_LOYALTY_BASE_PATH = "/api/loyalty/v1";

const getLoyaltyBasePath = (): string => {
  const configured = process.env.BACKENDCL_LOYALTY_BASE_PATH?.trim();
  const base = configured || DEFAULT_LOYALTY_BASE_PATH;
  return `/${base.replace(/^\/+|\/+$/g, "")}`;
};

/**
 * En BackendCL, `/api/loyalty/v1` lo intercepta primero el router OAuth de
 * partners y responde 401 a los JWT de sesión; las rutas de sesión viven en
 * `/api/loyalty/internal/v1`. Si el namespace configurado responde 401 o 404
 * reintentamos una vez con el otro, para sobrevivir a que BackendCL vuelva a
 * mover el prefijo sin necesidad de redesplegar el POS.
 */
const withLoyaltyNamespaceRetry = async <T>(
  suffix: string,
  request: (url: string, headers: Record<string, string>) => Promise<T>,
): Promise<T> => {
  const primary = getLoyaltyBasePath();
  const alternate =
    primary === PARTNER_LOYALTY_BASE_PATH
      ? DEFAULT_LOYALTY_BASE_PATH
      : PARTNER_LOYALTY_BASE_PATH;

  try {
    return await withBackendClAuthRetry((headers) =>
      request(buildBackendClApiUrl(`${primary}${suffix}`), headers),
    );
  } catch (error) {
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    if (status !== 401 && status !== 404) {
      throw error;
    }
    console.warn("[loyalty] namespace alterno tras error", {
      suffix,
      primary,
      alternate,
      status,
    });
    return withBackendClAuthRetry((headers) =>
      request(buildBackendClApiUrl(`${alternate}${suffix}`), headers),
    );
  }
};

const extractMember = (payload: unknown, memberId: string): ClubMemberData => {
  const root = payload as {
    data?: Record<string, unknown>;
    success?: boolean;
  };
  const data = root.data ?? (payload as Record<string, unknown>);

  const nombre =
    (data.nombre as string | undefined)?.trim() ||
    (data.displayName as string | undefined)?.trim() ||
    "Socio";
  const email = (data.email as string | undefined)?.trim() ?? "";
  const puntosActuales = Number(data.puntosActuales ?? 0);

  return {
    id: (data.id as string | undefined)?.trim()
      || (data.uid as string | undefined)?.trim()
      || memberId,
    nombre,
    email,
    puntosActuales: Number.isFinite(puntosActuales) ? puntosActuales : 0,
  };
};

const buildPosRedemptionMovementDocId = (ventaId: string): string =>
  `pos_${ventaId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120)}`;

export const recordPosRedemptionMovement = async (params: {
  memberId: string;
  ventaId: string;
  puntosCanjeados: number;
  saldoNuevo: number;
}): Promise<void> => {
  const trimmedMemberId = params.memberId.trim();
  const ventaId = params.ventaId.trim();
  const puntosCanjeados = Math.trunc(params.puntosCanjeados);
  const saldoNuevo = Math.trunc(params.saldoNuevo);

  if (!trimmedMemberId || !ventaId || puntosCanjeados <= 0) {
    return;
  }
  if (!Number.isFinite(saldoNuevo) || saldoNuevo < 0) {
    return;
  }

  const userRef = firestoreApp
    .collection(USUARIOS_APP_COLLECTION)
    .doc(trimmedMemberId);
  const docId = buildPosRedemptionMovementDocId(ventaId);
  const movRef = userRef.collection(MOVIMIENTOS_PUNTOS_SUBCOLLECTION).doc(docId);
  const existing = await movRef.get();
  if (existing.exists) {
    return;
  }

  const saldoAnterior = saldoNuevo + puntosCanjeados;
  await movRef.set({
    id: docId,
    usuarioId: trimmedMemberId,
    tipo: "CANJE",
    puntos: -puntosCanjeados,
    saldoAnterior,
    saldoNuevo,
    origen: "pos",
    origenId: ventaId,
    referencia: ventaId,
    descripcion: `Pago en concesión - ${ventaId}`,
    createdAt: FieldValue.serverTimestamp(),
  });
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

const getUsuariosAppByUid = async (
  uid: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> => {
  const directRef = firestoreApp.collection(USUARIOS_APP_COLLECTION).doc(uid);
  const directSnap = await directRef.get();
  if (directSnap.exists) {
    return { id: directSnap.id, data: (directSnap.data() ?? {}) as Record<string, unknown> };
  }

  const snapshot = await firestoreApp
    .collection(USUARIOS_APP_COLLECTION)
    .where("uid", "==", uid)
    .limit(1)
    .get();
  if (snapshot.empty) {
    return null;
  }

  const snap = snapshot.docs[0];
  return { id: snap.id, data: (snap.data() ?? {}) as Record<string, unknown> };
};

const memberFromUsuariosApp = (
  id: string,
  data: Record<string, unknown>,
  fallbackId: string,
): ClubMemberData => {
  const nombre =
    (data.nombre as string | undefined)?.trim() ||
    (data.displayName as string | undefined)?.trim() ||
    "Socio";
  const email = (data.email as string | undefined)?.trim() ?? "";
  const puntosActuales = Number(data.puntosActuales ?? 0);

  return {
    id:
      (data.uid as string | undefined)?.trim() ||
      id ||
      fallbackId,
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

  const url = buildBackendClApiUrl(
    `/api/usuarios/${encodeURIComponent(trimmedId)}`,
  );

  try {
    const resp = await withBackendClAuthRetry((headers) =>
      axios.get(url, { headers, timeout: 15000 }),
    );
    return extractMember(resp.data, trimmedId);
  } catch (error) {
    try {
      const fromFirestore = await getUsuariosAppByUid(trimmedId);
      if (fromFirestore) {
        return memberFromUsuariosApp(
          fromFirestore.id,
          fromFirestore.data,
          trimmedId,
        );
      }
    } catch {
      // Keep the original BackendCL error if Firestore is also unavailable.
    }
    throw mapAxiosError(error, "No se pudo validar el socio en Club León");
  }
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

  const descripcion = `Canje POS ${ventaId}`;
  const idempotencyKey = `pos-redeem:${ventaId}`;

  try {
    const createResp = await withLoyaltyNamespaceRetry(
      "/redemptions",
      (url, headers) =>
        axios.post(
          url,
          {
            memberId: trimmedId,
            points: puntosCanjeados,
            description: descripcion,
          },
          {
            headers: {
              ...headers,
              "Idempotency-Key": idempotencyKey,
            },
            timeout: 15000,
          },
        ),
    );

    const redemptionId = (
      createResp.data as { redemption?: { redemptionId?: string } }
    )?.redemption?.redemptionId;

    if (!redemptionId) {
      throw new ApiError(
        502,
        "BackendCL no devolvió redemptionId",
        true,
        "BACKENDCL_UNAVAILABLE",
      );
    }

    return {
      redemptionId,
      memberId: trimmedId,
      puntosCanjeados,
      descripcion,
    };
  } catch (error) {
    throw mapAxiosError(error, "No se pudieron reservar los puntos en Club León");
  }
};

export const confirmRedemptionHold = async (params: {
  redemptionId: string;
  ventaId: string;
  memberId: string;
  puntosCanjeados: number;
  descripcion: string;
}): Promise<RedeemPointsBySaleResult> => {
  const idempotencyKey = `pos-redeem:${params.ventaId}:confirm`;

  try {
    const confirmResp = await withLoyaltyNamespaceRetry(
      `/redemptions/${encodeURIComponent(params.redemptionId)}/confirm`,
      (url, headers) =>
        axios.post(
          url,
          {},
          {
            headers: {
              ...headers,
              "Idempotency-Key": idempotencyKey,
            },
            timeout: 15000,
          },
        ),
    );

    const balanceAfter = (
      confirmResp.data as { transaction?: { balanceAfter?: number } }
    )?.transaction?.balanceAfter;

    let puntosActuales = balanceAfter;
    if (!Number.isFinite(puntosActuales)) {
      const member = await getClubMember(params.memberId);
      puntosActuales = member.puntosActuales;
    }

    await recordPosRedemptionMovement({
      memberId: params.memberId,
      ventaId: params.ventaId,
      puntosCanjeados: params.puntosCanjeados,
      saldoNuevo: Number(puntosActuales),
    });

    return {
      memberId: params.memberId,
      puntosCanjeados: params.puntosCanjeados,
      montoPuntos: calcularMontoDesdePuntos(params.puntosCanjeados),
      puntosActuales: Number(puntosActuales),
      descripcion: params.descripcion,
      redemptionId: params.redemptionId,
      externalResponse: confirmResp.data,
    };
  } catch (error) {
    throw mapAxiosError(error, "No se pudieron canjear los puntos en Club León");
  }
};

export const cancelRedemptionHold = async (params: {
  redemptionId: string;
  ventaId: string;
}): Promise<void> => {
  try {
    await withLoyaltyNamespaceRetry(
      `/redemptions/${encodeURIComponent(params.redemptionId)}/cancel`,
      (url, headers) =>
        axios.post(
          url,
          {},
          {
            headers: {
              ...headers,
              "Idempotency-Key": `pos-redeem:${params.ventaId}:cancel`,
            },
            timeout: 15000,
          },
        ),
    );
  } catch (error) {
    console.error("No se pudo cancelar la reserva de puntos", error);
  }
};

const describeBackendClError = (
  error: unknown,
): { status?: number; code?: string; message?: string } => {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { message?: string; code?: string; detail?: string; title?: string }
      | undefined;
    return {
      status: error.response?.status,
      code: data?.code ?? error.code,
      message: data?.detail ?? data?.message ?? data?.title ?? error.message,
    };
  }
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
 * Acredita la venta en el ledger oficial de Club León.
 *
 * `externalTransactionId` viaja explícito para que BackendCL deduplique por
 * venta: la acumulación en vivo, el reproceso de la cola de pendientes y el
 * script de reparación histórica comparten la clave `pos-sale:<ventaId>` y por
 * eso pueden ejecutarse cuantas veces haga falta sin duplicar puntos.
 */
const postAccrualToBackendCl = async (params: {
  memberId: string;
  total: number;
  ventaId: string;
  folioVenta: string;
  descripcion: string;
  puntosAsignados: number;
}): Promise<AssignPointsBySaleResult> => {
  const url = buildBackendClApiUrl(
    `/api/usuarios/${encodeURIComponent(params.memberId)}/puntos/asignar-por-venta`,
  );
  const externalTransactionId = buildPosSaleIdempotencyKey(params.ventaId);

  const resp = await withBackendClAuthRetry((headers) =>
    axios.post(
      url,
      {
        folioVenta: params.folioVenta,
        dinero: params.total,
        descripcion: params.descripcion,
        externalTransactionId,
      },
      {
        headers: { ...headers, "Idempotency-Key": externalTransactionId },
        timeout: 15000,
      },
    ),
  );

  const payload = resp.data as {
    alreadyProcessed?: boolean;
    data?: {
      puntosActuales?: number;
      puntosAsignados?: number;
      montoVenta?: number;
      alreadyProcessed?: boolean;
      externalTransactionId?: string;
    };
  };

  const alreadyProcessed = Boolean(
    payload.alreadyProcessed ?? payload.data?.alreadyProcessed,
  );

  return {
    memberId: params.memberId,
    montoVenta: payload.data?.montoVenta ?? params.total,
    puntosAsignados: payload.data?.puntosAsignados ?? params.puntosAsignados,
    puntosActuales: payload.data?.puntosActuales ?? 0,
    descripcion: params.descripcion,
    status: alreadyProcessed ? "ALREADY_PROCESSED" : "APPLIED",
    alreadyProcessed,
    externalTransactionId,
    externalResponse: resp.data,
  };
};

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
  const folioVenta = (params.folioVenta ?? ventaId).trim();

  try {
    const result = await postAccrualToBackendCl({
      memberId: trimmedId,
      total,
      ventaId,
      folioVenta,
      descripcion,
      puntosAsignados,
    });
    // Si esta venta venía arrastrando un pendiente, ya quedó saldada.
    await markPendingAccrualCompleted({
      ventaId,
      alreadyProcessed: result.alreadyProcessed,
    }).catch(() => undefined);
    return result;
  } catch (error) {
    const detail = describeBackendClError(error);

    // Un rechazo de negocio (socio inexistente, monto inválido) no se encola:
    // reintentarlo nunca va a funcionar y ensuciaría la cola.
    if (
      detail.status != null &&
      detail.status >= 400 &&
      detail.status < 500 &&
      detail.status !== 429
    ) {
      throw mapAxiosError(error, "No se pudieron asignar los puntos en Club León");
    }

    console.error("[loyalty] acumulación diferida: BackendCL no disponible", {
      ventaId,
      memberId: trimmedId,
      puntos: puntosAsignados,
      ...detail,
    });

    // La venta ya ocurrió: no se pierde ni se inventa un saldo paralelo.
    // Queda como operación PENDING para reintegrarse al ledger oficial.
    const pending = await enqueuePendingAccrual({
      memberId: trimmedId,
      ventaId,
      folioVenta,
      puntos: puntosAsignados,
      total,
      descripcion,
      concesionId: params.concesionId,
      sucursalId: params.sucursalId,
      cajaId: params.cajaId,
      error: detail,
    });

    return {
      memberId: trimmedId,
      montoVenta: total,
      puntosAsignados,
      // Desconocido a propósito: el saldo real solo lo dicta el ledger.
      puntosActuales: 0,
      descripcion,
      status: "PENDING",
      alreadyProcessed: false,
      externalTransactionId: pending.idempotencyKey,
      externalResponse: {
        source: "pending-queue",
        status: pending.status,
        attempts: pending.attempts,
        lastError: detail,
      },
    };
  }
};

/**
 * Reintegra al ledger oficial las acumulaciones que quedaron pendientes.
 * Idempotente: una venta ya acreditada responde ALREADY_PROCESSED y no suma.
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
      const result = await postAccrualToBackendCl({
        memberId: pendiente.memberId,
        total: pendiente.total,
        ventaId: pendiente.ventaId,
        folioVenta: pendiente.folioVenta || pendiente.ventaId,
        descripcion: pendiente.descripcion,
        puntosAsignados: pendiente.puntos,
      });

      await markPendingAccrualCompleted({
        ventaId: pendiente.ventaId,
        alreadyProcessed: result.alreadyProcessed,
      });

      if (result.alreadyProcessed) {
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
      const detail = describeBackendClError(error);
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
