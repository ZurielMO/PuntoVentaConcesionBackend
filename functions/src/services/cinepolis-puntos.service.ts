import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import * as loyaltyPointsService from "./loyalty-points.service";

export type CinepolisAsignacion = {
  id: string;
  memberId: string;
  customerFullName: string;
  amountMxn: number;
  points: number;
  puntosActuales: number;
  comentario: string;
  folioVenta: string;
  cashierUid: string;
  cashierEmail: string;
  createdAt: string | null;
};

const asignacionesCol = () =>
  firestorePos.collection(COLLECTIONS.CINEPOLIS_ASIGNACIONES);

const toIso = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
};

export const generateCinepolisFolio = (now = new Date()): string => {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  const suffix = randomBytes(2).toString("hex").toUpperCase();
  return `CP-${y}${m}${d}${hh}${mm}${ss}-${suffix}`;
};

export const normalizeCinepolisComentario = (comentario?: string): string => {
  const trimmed = comentario?.trim() ?? "";
  if (!trimmed) return "Cinépolis";
  return trimmed.slice(0, 250);
};

const asText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const mapAsignacion = (
  id: string,
  data: Record<string, unknown>,
): CinepolisAsignacion => ({
  id,
  memberId: asText(data.memberId),
  customerFullName: asText(data.customerFullName, "Socio"),
  amountMxn: Number(data.amountMxn ?? 0),
  points: Number(data.points ?? 0),
  puntosActuales: Number(data.puntosActuales ?? 0),
  comentario: asText(data.comentario),
  folioVenta: asText(data.folioVenta),
  cashierUid: asText(data.cashierUid),
  cashierEmail: asText(data.cashierEmail),
  createdAt: toIso(data.createdAt),
});

export const assignCinepolisPoints = async (params: {
  memberId: string;
  dinero: number;
  comentario?: string;
  cashierUid: string;
  cashierEmail: string;
}) => {
  const member = await loyaltyPointsService.getClubMember(params.memberId);
  const folioVenta = generateCinepolisFolio();
  const descripcion = normalizeCinepolisComentario(params.comentario);

  const result = await loyaltyPointsService.assignPointsBySale({
    memberId: member.id,
    total: params.dinero,
    ventaId: folioVenta,
    folioVenta,
    descripcion,
  });

  const docRef = asignacionesCol().doc();
  await docRef.set({
    memberId: member.id,
    customerFullName: member.nombre,
    amountMxn: result.montoVenta,
    points: result.puntosAsignados,
    puntosActuales: result.puntosActuales,
    comentario: descripcion,
    folioVenta,
    cashierUid: params.cashierUid,
    cashierEmail: params.cashierEmail,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    memberId: result.memberId,
    montoVenta: result.montoVenta,
    puntosAsignados: result.puntosAsignados,
    puntosActuales: result.puntosActuales,
    descripcion: result.descripcion,
    folioVenta,
    customerFullName: member.nombre,
    assignmentId: docRef.id,
  };
};

export const listCinepolisAsignaciones = async (params: {
  limit?: number;
  cursor?: string;
}): Promise<{
  items: CinepolisAsignacion[];
  nextCursor: string | null;
  hasMore: boolean;
}> => {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  let query = asignacionesCol().orderBy("createdAt", "desc").limit(limit + 1);

  if (params.cursor?.trim()) {
    const cursorDoc = await asignacionesCol().doc(params.cursor.trim()).get();
    if (!cursorDoc.exists) {
      throw new ApiError(400, "Cursor de paginación inválido", true, "INVALID_CURSOR");
    }
    query = query.startAfter(cursorDoc);
  }

  const snap = await query.get();
  const docs = snap.docs.slice(0, limit);
  const hasMore = snap.docs.length > limit;

  return {
    items: docs.map((doc) =>
      mapAsignacion(doc.id, (doc.data() ?? {}) as Record<string, unknown>),
    ),
    nextCursor: hasMore ? docs[docs.length - 1]?.id ?? null : null,
    hasMore,
  };
};
