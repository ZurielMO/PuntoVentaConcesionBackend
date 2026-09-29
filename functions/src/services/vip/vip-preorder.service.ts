import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../../config/firebase";
import { COLLECTIONS } from "../../config/firestore.constants";
import { getVipBusinessDate } from "../../config/vip.config";
import type { VipPreorderInfo, VipStadiumZone } from "../../models/vip.model";
import { ApiError } from "../../utils/api-error";
import { buildJornadaId, ramaFromInventario } from "../asignacion-caja.service";
import {
  applyRememberedDetails,
  loadRememberedJornadaActiva,
  type RememberedJornada,
} from "../jornada-activa-cache";
import { getJornadaActiva, type JornadaActivaValue } from "../jornada.service";
import {
  buildPreorderMatch,
  buildPreorderSlots,
  normalizeMatchDate,
  normalizePreorderSettings,
  parseKickoffMinutes,
  preorderSlotId,
  type VipPreorderMatch,
  type VipPreorderMatchOverride,
  type VipPreorderSettings,
} from "./vip-preorder.utils";

type PreorderCatalog = {
  settings: VipPreorderSettings;
  matches: VipPreorderMatch[];
};

const CATALOG_CACHE_TTL_MS = 20_000;
let catalogCache: { value: PreorderCatalog; expiresAt: number } | null = null;

export const clearVipPreorderCache = (): void => {
  catalogCache = null;
};

const configCol = () => firestorePos.collection(COLLECTIONS.VIP_PREORDER_CONFIGS);
const slotCol = () => firestorePos.collection(COLLECTIONS.VIP_PREORDER_SLOTS);

const isVaronilActiva = (row: JornadaActivaValue | null | undefined): row is JornadaActivaValue =>
  Boolean(row)
  && row?.activo === true
  && String(row?.rama || "varonil").toLowerCase() !== "femenil";

/**
 * Misma red que el inventario de concesiones cuando Acreditaciones no responde:
 * cada header varonil abierto es una jornada (fecha + número), sin cerrar las demás.
 */
const loadOpenVaronilInventoryJornadas = async (): Promise<JornadaActivaValue[]> => {
  const snap = await firestorePos.collection(COLLECTIONS.INVENTARIOS).where("activo", "==", true).get();
  const byMatch = new Map<string, JornadaActivaValue>();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (ramaFromInventario(data, doc.id) !== "varonil") continue;
    const fecha = normalizeMatchDate(data.jornada_fecha);
    const numero = Number(data.jornada_numero);
    if (!fecha || !Number.isInteger(numero) || numero <= 0) continue;
    const key = `${fecha}__${numero}`;
    if (byMatch.has(key)) continue;
    byMatch.set(key, {
      activo: true,
      rama: "varonil",
      jornada: numero,
      fecha,
      hora: typeof data.hora === "string" ? data.hora : undefined,
      equipo_local: typeof data.equipo_local === "string" ? data.equipo_local : undefined,
      equipo_visitante: typeof data.equipo_visitante === "string" ? data.equipo_visitante : undefined,
      estadio: typeof data.estadio === "string" ? data.estadio : undefined,
    });
  }
  return [...byMatch.values()];
};

const hasKickoff = (row: JornadaActivaValue): boolean =>
  parseKickoffMinutes(row.hora) !== null || parseKickoffMinutes(row.fecha) !== null;

const readRememberedVaronil = async (): Promise<RememberedJornada | null> => {
  try {
    return await loadRememberedJornadaActiva("varonil");
  } catch (error) {
    console.warn("vip_preorder_jornada_cache_unavailable", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return null;
  }
};

/**
 * Orden de lectura: Acreditaciones, luego la última jornada guardada con hora,
 * y al final el inventario abierto. Un fallo de red no borra el partido.
 * Si Acreditaciones responde que no hay jornada activa, no se revive una vieja.
 */
const loadActiveVaronilJornadas = async (): Promise<JornadaActivaValue[]> => {
  try {
    const activas = await getJornadaActiva();
    const varonil = Object.values(activas || {}).filter(isVaronilActiva);
    if (!varonil.length) return [];
    const remembered = await readRememberedVaronil();
    return varonil.map((row) => applyRememberedDetails(row, remembered));
  } catch (error) {
    console.warn("vip_preorder_jornadas_unavailable", {
      message: error instanceof Error ? error.message : "unknown error",
    });
  }

  const remembered = await readRememberedVaronil();
  if (remembered && isVaronilActiva(remembered) && hasKickoff(remembered)) {
    return [remembered];
  }

  const inventory = await loadOpenVaronilInventoryJornadas();
  return inventory.map((row) => applyRememberedDetails(row, remembered));
};

/**
 * Partidos elegibles para preventa. La fecha no puede haber pasado y cada
 * partido necesita hora de inicio para armar el rango de 50 minutos.
 */
const loadPreorderCatalog = async (options: { fresh?: boolean } = {}): Promise<PreorderCatalog> => {
  const now = Date.now();
  if (!options.fresh && catalogCache && catalogCache.expiresAt > now) return catalogCache.value;
  const [defaultDoc, jornadas] = await Promise.all([
    configCol().doc("default").get(),
    loadActiveVaronilJornadas(),
  ]);
  const settings = normalizePreorderSettings(defaultDoc.exists ? defaultDoc.data() : undefined);
  const today = getVipBusinessDate();
  const candidates = new Map<string, { matchDate: string; numero: number; source: JornadaActivaValue }>();
  for (const jornada of jornadas) {
    const matchDate = normalizeMatchDate(jornada.fecha);
    const numero = Number(jornada.jornada);
    if (!matchDate || matchDate < today || !Number.isInteger(numero) || numero <= 0) continue;
    const matchId = buildJornadaId(matchDate, numero, "varonil");
    if (!candidates.has(matchId)) candidates.set(matchId, { matchDate, numero, source: jornada });
  }
  const entries = [...candidates.entries()];
  const overrides = await Promise.all(entries.map(([matchId]) => configCol().doc(matchId).get()));
  const matches = entries
    .map(([matchId, candidate], index) => buildPreorderMatch(
      matchId,
      candidate.matchDate,
      candidate.numero,
      candidate.source,
      overrides[index].exists ? overrides[index].data() as VipPreorderMatchOverride : undefined,
      settings,
    ))
    .filter((match): match is VipPreorderMatch => Boolean(match))
    .sort((a, b) => (a.kickoffAt ?? 0) - (b.kickoffAt ?? 0) || a.matchDate.localeCompare(b.matchDate));
  const value = { settings, matches };
  catalogCache = { value, expiresAt: now + CATALOG_CACHE_TTL_MS };
  return value;
};

const publicMatch = (match: VipPreorderMatch) => ({
  matchId: match.matchId,
  jornadaNumero: match.jornadaNumero,
  matchDate: match.matchDate,
  matchLabel: match.matchLabel,
  homeTeam: match.homeTeam,
  awayTeam: match.awayTeam,
  stadium: match.stadium,
  kickoffAt: match.kickoffAt !== null ? new Date(match.kickoffAt).toISOString() : null,
});

export const getPreorderAvailability = async (_zona?: VipStadiumZone, now = Date.now()) => {
  const { settings, matches } = await loadPreorderCatalog();
  const base = {
    enabled: settings.enabled,
    slotMinutes: settings.slotMinutes,
    leadMinutes: settings.leadMinutes,
    windowBeforeMinutes: settings.windowBeforeKickoffMinutes,
    windowAfterMinutes: settings.windowAfterKickoffMinutes,
  };
  if (!settings.enabled) return { ...base, matches: [] };
  const result = [];
  for (const match of matches) {
    const slots = buildPreorderSlots(match, settings, now).filter((slot) => slot.bookable);
    if (!slots.length) continue;
    result.push({
      ...publicMatch(match),
      windows: slots.map((slot) => ({
        start: slot.start,
        end: slot.end,
        label: slot.label,
        startAt: new Date(slot.startAt).toISOString(),
        endAt: new Date(slot.endAt).toISOString(),
        available: true,
        remaining: null,
      })),
    });
  }
  return { ...base, matches: result };
};

/** Interruptor de Central, aparte de si ya hay una ventana reservable. */
export const getPublicPreorderFlags = async (now = Date.now()): Promise<{
  enabled: boolean;
  open: boolean;
}> => {
  const { settings, matches } = await loadPreorderCatalog();
  const open = settings.enabled && matches.some((match) =>
    buildPreorderSlots(match, settings, now).some((slot) => slot.bookable));
  return { enabled: settings.enabled, open };
};

export const hasOpenPreorders = async (now = Date.now()): Promise<boolean> =>
  (await getPublicPreorderFlags(now)).open;

export type ResolvedPreorderSelection = {
  matchDate: string;
  capacity: number;
  slotRef: FirebaseFirestore.DocumentReference;
  info: VipPreorderInfo;
  zona: VipStadiumZone;
};

/** Revalida partido y ventana en servidor; el cliente solo propone matchId + "HH:mm". */
export const resolvePreorderSelection = async (
  selection: { matchId: string; windowStart: string },
  zona: VipStadiumZone,
  now = Date.now(),
): Promise<ResolvedPreorderSelection> => {
  const { settings, matches } = await loadPreorderCatalog({ fresh: true });
  if (!settings.enabled) {
    throw new ApiError(409, "La preventa no está disponible en este momento.", true, "VIP_PREORDER_CLOSED");
  }
  const match = matches.find((row) => row.matchId === selection.matchId);
  if (!match) {
    throw new ApiError(409, "El partido elegido ya no está disponible para preventa.", true, "VIP_PREORDER_MATCH_UNAVAILABLE");
  }
  const slot = buildPreorderSlots(match, settings, now).find((row) => row.start === selection.windowStart);
  if (!slot) {
    throw new ApiError(400, "El horario elegido no es válido para este partido.", true, "VIP_PREORDER_WINDOW_INVALID");
  }
  if (!slot.bookable) {
    throw new ApiError(409, "Ese horario ya cerró. Elige un horario posterior.", true, "VIP_PREORDER_WINDOW_CLOSED");
  }
  const slotId = preorderSlotId(match.matchId, zona, slot.key);
  return {
    matchDate: match.matchDate,
    capacity: match.slotCapacity,
    slotRef: slotCol().doc(slotId),
    zona,
    info: {
      matchId: match.matchId,
      jornadaNumero: match.jornadaNumero,
      matchDate: match.matchDate,
      matchLabel: match.matchLabel,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      stadium: match.stadium,
      kickoffAt: match.kickoffAt !== null ? Timestamp.fromMillis(match.kickoffAt) : null,
      windowStart: slot.start,
      windowEnd: slot.end,
      windowLabel: slot.label,
      windowStartAt: Timestamp.fromMillis(slot.startAt),
      windowEndAt: Timestamp.fromMillis(slot.endAt),
      slotId,
    },
  };
};

export const preorderSlotRef = (slotId: string) => slotCol().doc(slotId);

export const getPreorderSettingsStatus = async () => {
  const { settings, matches } = await loadPreorderCatalog({ fresh: true });
  const now = Date.now();
  return {
    enabled: settings.enabled,
    slotMinutes: settings.slotMinutes,
    slotStepMinutes: settings.slotStepMinutes,
    leadMinutes: settings.leadMinutes,
    slotCapacity: settings.slotCapacity,
    matches: matches.map((match) => ({
      ...publicMatch(match),
      openWindows: buildPreorderSlots(match, settings, now).filter((slot) => slot.bookable).length,
    })),
  };
};

export const setPreorderEnabled = async (enabled: boolean, actorId: string | null) => {
  await configCol().doc("default").set({
    enabled,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actorId,
  }, { merge: true });
  clearVipPreorderCache();
  return getPreorderSettingsStatus();
};
