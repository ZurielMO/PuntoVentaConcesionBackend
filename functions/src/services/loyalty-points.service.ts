import axios from "axios";
import { FieldValue } from "firebase-admin/firestore";
import { firestoreApp } from "../config/app.firebase";
import {
  buildBackendClApiUrl,
  getBackendClBearerToken,
  invalidateBackendClAuthCache,
} from "./backendcl-auth.service";
import { ApiError } from "../utils/api-error";

const USUARIOS_APP_COLLECTION = "usuariosApp";
const MOVIMIENTOS_PUNTOS_SUBCOLLECTION = "movimientos_puntos";

export interface ClubMemberData {
  id: string;
  nombre: string;
  email: string;
  puntosActuales: number;
}

export interface AssignPointsBySaleResult {
  memberId: string;
  montoVenta: number;
  puntosAsignados: number;
  puntosActuales: number;
  descripcion: string;
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
  const createUrl = buildBackendClApiUrl("/api/loyalty/v1/redemptions");

  try {
    const createResp = await withBackendClAuthRetry((headers) =>
      axios.post(
        createUrl,
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
  const confirmUrl = buildBackendClApiUrl(
    `/api/loyalty/v1/redemptions/${encodeURIComponent(
      params.redemptionId,
    )}/confirm`,
  );

  try {
    const confirmResp = await withBackendClAuthRetry((headers) =>
      axios.post(
        confirmUrl,
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
  const cancelUrl = buildBackendClApiUrl(
    `/api/loyalty/v1/redemptions/${encodeURIComponent(
      params.redemptionId,
    )}/cancel`,
  );

  try {
    await withBackendClAuthRetry((headers) =>
      axios.post(
        cancelUrl,
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

const buildPosAccumulationMovementDocId = (ventaId: string): string =>
  `pos_acc_${ventaId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120)}`;

const assignPointsBySaleInUsuariosApp = async (params: {
  memberId: string;
  total: number;
  ventaId: string;
  puntosAsignados: number;
  descripcion: string;
}): Promise<AssignPointsBySaleResult> => {
  const user = await getUsuariosAppByUid(params.memberId);
  if (!user) {
    throw new ApiError(404, "Socio no encontrado", true, "MEMBER_NOT_FOUND");
  }

  const userRef = firestoreApp.collection(USUARIOS_APP_COLLECTION).doc(user.id);
  const docId = buildPosAccumulationMovementDocId(params.ventaId);
  const movRef = userRef.collection(MOVIMIENTOS_PUNTOS_SUBCOLLECTION).doc(docId);
  const existing = await movRef.get();
  if (existing.exists) {
    const data = existing.data() as { saldoNuevo?: number } | undefined;
    const puntosActuales = Number(
      data?.saldoNuevo ?? user.data.puntosActuales ?? 0,
    );
    return {
      memberId: user.id,
      montoVenta: params.total,
      puntosAsignados: params.puntosAsignados,
      puntosActuales: Number.isFinite(puntosActuales) ? puntosActuales : 0,
      descripcion: params.descripcion,
      externalResponse: { source: "usuariosApp", alreadyAssigned: true },
    };
  }

  const saldoAnterior = Number(user.data.puntosActuales ?? 0);
  const saldoNuevo = saldoAnterior + params.puntosAsignados;

  await movRef.set({
    id: docId,
    usuarioId: user.id,
    tipo: "ACUMULACION",
    puntos: params.puntosAsignados,
    saldoAnterior,
    saldoNuevo,
    origen: "pos",
    origenId: params.ventaId,
    referencia: params.ventaId,
    descripcion: params.descripcion,
    createdAt: FieldValue.serverTimestamp(),
  });
  await userRef.set(
    {
      puntosActuales: saldoNuevo,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return {
    memberId: user.id,
    montoVenta: params.total,
    puntosAsignados: params.puntosAsignados,
    puntosActuales: saldoNuevo,
    descripcion: params.descripcion,
    externalResponse: { source: "usuariosApp", alreadyAssigned: false },
  };
};

export const assignPointsBySale = async (params: {
  memberId: string;
  total: number;
  ventaId: string;
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
  const descripcion = `Venta POS ${ventaId}`;

  const url = buildBackendClApiUrl(
    `/api/usuarios/${encodeURIComponent(trimmedId)}/puntos/asignar-por-venta`,
  );

  try {
    const resp = await withBackendClAuthRetry((headers) =>
      axios.post(
        url,
        { dinero: total, descripcion },
        { headers, timeout: 15000 },
      ),
    );

    const payload = resp.data as {
      data?: {
        puntosActuales?: number;
        puntosAsignados?: number;
        montoVenta?: number;
      };
    };

    return {
      memberId: trimmedId,
      montoVenta: payload.data?.montoVenta ?? total,
      puntosAsignados: payload.data?.puntosAsignados ?? puntosAsignados,
      puntosActuales: payload.data?.puntosActuales ?? 0,
      descripcion,
      externalResponse: resp.data,
    };
  } catch (error) {
    try {
      return await assignPointsBySaleInUsuariosApp({
        memberId: trimmedId,
        total,
        ventaId,
        puntosAsignados,
        descripcion,
      });
    } catch (fallbackError) {
      if (
        fallbackError instanceof ApiError &&
        fallbackError.code !== "MEMBER_NOT_FOUND"
      ) {
        throw fallbackError;
      }
    }
    throw mapAxiosError(error, "No se pudieron asignar los puntos en Club León");
  }
};
