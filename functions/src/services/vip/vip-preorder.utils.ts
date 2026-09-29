import { randomBytes } from "crypto";
import type { VipPreorderInfo } from "../../models/vip.model";

export const VIP_TIME_ZONE = "America/Mexico_City";

/** Ventana mínima que se le promete al cliente (requisito operativo). */
export const VIP_PREORDER_MIN_WINDOW_MINUTES = 25;

export type VipPreorderSettings = {
  enabled: boolean;
  /** Duración de cada ventana de entrega. */
  slotMinutes: number;
  /** Separación entre inicios de ventana (≥ slotMinutes: sin traslapes). */
  slotStepMinutes: number;
  /** Anticipación mínima entre la compra y el inicio de la ventana. */
  leadMinutes: number;
  /** Pedidos máximos por ventana y zona (Oriente / Poniente). */
  slotCapacity: number;
  windowBeforeKickoffMinutes: number;
  windowAfterKickoffMinutes: number;
};

export const DEFAULT_VIP_PREORDER_SETTINGS: VipPreorderSettings = {
  enabled: true,
  slotMinutes: VIP_PREORDER_MIN_WINDOW_MINUTES,
  slotStepMinutes: 30,
  leadMinutes: 45,
  slotCapacity: 12,
  windowBeforeKickoffMinutes: 50,
  windowAfterKickoffMinutes: 50,
};

const LAST_MINUTE_OF_DAY = 23 * 60 + 59;
const MAX_SLOTS_PER_MATCH = 48;

const boundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

export const normalizePreorderSettings = (
  data?: Record<string, unknown> | null,
): VipPreorderSettings => {
  const defaults = DEFAULT_VIP_PREORDER_SETTINGS;
  const slotMinutes = boundedInt(data?.slotMinutes, defaults.slotMinutes, VIP_PREORDER_MIN_WINDOW_MINUTES, 90);
  return {
    enabled: data?.enabled !== false,
    slotMinutes,
    slotStepMinutes: Math.max(slotMinutes, boundedInt(data?.slotStepMinutes, defaults.slotStepMinutes, 5, 120)),
    leadMinutes: boundedInt(data?.leadMinutes, defaults.leadMinutes, VIP_PREORDER_MIN_WINDOW_MINUTES, 7 * 24 * 60),
    slotCapacity: boundedInt(data?.slotCapacity, defaults.slotCapacity, 1, 500),
    windowBeforeKickoffMinutes: boundedInt(data?.windowBeforeKickoffMinutes, defaults.windowBeforeKickoffMinutes, 0, 240),
    windowAfterKickoffMinutes: boundedInt(data?.windowAfterKickoffMinutes, defaults.windowAfterKickoffMinutes, 0, 240),
  };
};

export const boundedSlotCapacity = (value: unknown, fallback: number): number =>
  boundedInt(value, fallback, 1, 500);

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const minutesToHm = (minutes: number): string => {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
};

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const parseHm = (value: unknown): number | null => {
  const match = String(value ?? "").trim().match(HM_RE);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * Hora de inicio del partido tal como la captura acreditaciones:
 * "19:00", "19:00 hrs", "7:05 PM", "1900", "2026-10-04T19:00:00".
 */
export const parseKickoffMinutes = (raw: unknown): number | null => {
  let text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  const isoTime = text.match(/t(\d{2}):(\d{2})/);
  if (isoTime) text = `${isoTime[1]}:${isoTime[2]}`;
  let hours: number;
  let minutes: number;
  const compact = text.match(/^(\d{2})(\d{2})$/);
  const separated = text.match(/(?:^|\s)(\d{1,2})\s*[:.h]\s*(\d{2})(?!\d)/);
  const hourOnly = text.match(/^(\d{1,2})\s*(?:hrs?\.?|h)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?$/);
  if (compact) {
    hours = Number(compact[1]);
    minutes = Number(compact[2]);
  } else if (separated) {
    hours = Number(separated[1]);
    minutes = Number(separated[2]);
  } else if (hourOnly) {
    hours = Number(hourOnly[1]);
    minutes = 0;
  } else {
    return null;
  }
  const meridiem = text.match(/\d\s*([ap])\.?\s*m\b/)?.[1] ?? null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/** Acepta "YYYY-MM-DD", ISO con hora y "DD/MM/YYYY". */
export const normalizeMatchDate = (raw: unknown): string | null => {
  const text = String(raw ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${pad2(Number(dmy[2]))}-${pad2(Number(dmy[1]))}`;
  return null;
};

const zonedFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: VIP_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const zoneOffsetMinutes = (utcMillis: number): number => {
  const parts = Object.fromEntries(
    zonedFormatter.formatToParts(new Date(utcMillis)).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
  );
  return Math.round((asUtc - Math.floor(utcMillis / 60_000) * 60_000) / 60_000);
};

/** Convierte fecha + minutos del día en hora local del estadio a epoch millis. */
export const stadiumLocalToMillis = (dateIso: string, minutesOfDay: number): number => {
  const [year, month, day] = dateIso.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day) + minutesOfDay * 60_000;
  const firstGuess = naive - zoneOffsetMinutes(naive) * 60_000;
  return naive - zoneOffsetMinutes(firstGuess) * 60_000;
};

export type VipPreorderMatchSource = {
  jornada?: unknown;
  fecha?: unknown;
  hora?: unknown;
  equipo_local?: unknown;
  equipo_visitante?: unknown;
  estadio?: unknown;
};

export type VipPreorderMatchOverride = {
  enabled?: unknown;
  kickoff?: unknown;
  windowStart?: unknown;
  windowEnd?: unknown;
  slotCapacity?: unknown;
};

export type VipPreorderMatch = {
  matchId: string;
  jornadaNumero: number;
  matchDate: string;
  homeTeam: string | null;
  awayTeam: string | null;
  stadium: string | null;
  matchLabel: string;
  kickoffAt: number | null;
  firstStartMinutes: number;
  lastEndMinutes: number;
  slotCapacity: number;
};

export type VipPreorderSlot = {
  key: string;
  start: string;
  end: string;
  label: string;
  startAt: number;
  endAt: number;
  bookable: boolean;
};

const cleanText = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 80) : null;
};

export const buildPreorderMatch = (
  matchId: string,
  matchDate: string,
  jornadaNumero: number,
  source: VipPreorderMatchSource,
  override: VipPreorderMatchOverride | undefined,
  settings: VipPreorderSettings,
): VipPreorderMatch | null => {
  if (override?.enabled === false) return null;
  const kickoffMinutes =
    parseHm(override?.kickoff) ??
    parseKickoffMinutes(source.hora) ??
    parseKickoffMinutes(source.fecha);
  const overrideStart = parseHm(override?.windowStart);
  const overrideEnd = parseHm(override?.windowEnd);
  let first: number;
  let last: number;
  if (overrideStart !== null && overrideEnd !== null && overrideEnd > overrideStart) {
    first = overrideStart;
    last = overrideEnd;
  } else if (kickoffMinutes !== null) {
    first = Math.max(0, kickoffMinutes - settings.windowBeforeKickoffMinutes);
    last = kickoffMinutes + settings.windowAfterKickoffMinutes;
  } else {
    // Sin hora del partido no se inventan horarios de entrega.
    return null;
  }
  last = Math.min(last, LAST_MINUTE_OF_DAY);
  if (last - first < settings.slotMinutes) return null;
  const homeTeam = cleanText(source.equipo_local);
  const awayTeam = cleanText(source.equipo_visitante);
  return {
    matchId,
    jornadaNumero,
    matchDate,
    homeTeam,
    awayTeam,
    stadium: cleanText(source.estadio),
    matchLabel: homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : `Partido ${jornadaNumero}`,
    kickoffAt: kickoffMinutes !== null ? stadiumLocalToMillis(matchDate, kickoffMinutes) : null,
    firstStartMinutes: first,
    lastEndMinutes: last,
    slotCapacity: boundedSlotCapacity(override?.slotCapacity, settings.slotCapacity),
  };
};

export const buildPreorderSlots = (
  match: VipPreorderMatch,
  settings: VipPreorderSettings,
  now = Date.now(),
): VipPreorderSlot[] => {
  const slots: VipPreorderSlot[] = [];
  for (
    let start = match.firstStartMinutes;
    start + settings.slotMinutes <= match.lastEndMinutes && slots.length < MAX_SLOTS_PER_MATCH;
    start += settings.slotStepMinutes
  ) {
    const end = start + settings.slotMinutes;
    const startAt = stadiumLocalToMillis(match.matchDate, start);
    const startHm = minutesToHm(start);
    const endHm = minutesToHm(end);
    slots.push({
      key: startHm.replace(":", ""),
      start: startHm,
      end: endHm,
      label: `${startHm} – ${endHm}`,
      startAt,
      endAt: stadiumLocalToMillis(match.matchDate, end),
      bookable: startAt - now >= settings.leadMinutes * 60_000,
    });
  }
  return slots;
};

export const preorderSlotId = (matchId: string, zona: string, slotKey: string): string =>
  `${matchId}__${zona}__${slotKey}`;

/** Crockford base32: sin I, L, O ni U para evitar confusiones al dictarlo. */
const GUIDE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const VIP_GUIDE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export const generateGuideCode = (): string => {
  let code = "";
  // 256 es múltiplo de 32: `byte & 31` es uniforme.
  for (const byte of randomBytes(8)) code += GUIDE_ALPHABET[byte & 31];
  return code;
};

export const normalizeGuideCode = (raw: unknown): string | null => {
  const cleaned = String(raw ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return VIP_GUIDE_CODE_RE.test(cleaned) ? cleaned : null;
};

export const formatGuideCode = (code?: string | null): string | null => {
  if (!code) return null;
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
};

const timestampToIso = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === "object" && value !== null && "toMillis" in value &&
      typeof (value as { toMillis: unknown }).toMillis === "function") {
    return new Date((value as { toMillis: () => number }).toMillis()).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
};

export const serializePreorderInfo = (info?: VipPreorderInfo | null) => {
  if (!info) return null;
  return {
    matchId: info.matchId,
    jornadaNumero: info.jornadaNumero,
    matchDate: info.matchDate,
    matchLabel: info.matchLabel,
    homeTeam: info.homeTeam,
    awayTeam: info.awayTeam,
    stadium: info.stadium,
    kickoffAt: timestampToIso(info.kickoffAt),
    windowStart: info.windowStart,
    windowEnd: info.windowEnd,
    windowLabel: info.windowLabel,
    windowStartAt: timestampToIso(info.windowStartAt),
    windowEndAt: timestampToIso(info.windowEndAt),
  };
};

const matchDateFormatter = new Intl.DateTimeFormat("es-MX", {
  timeZone: VIP_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "domingo 4 de octubre" a partir de "2026-10-04" (mediodía local, sin saltos de día). */
export const formatMatchDateLong = (matchDate: string): string => {
  const millis = stadiumLocalToMillis(matchDate, 12 * 60);
  return matchDateFormatter.format(new Date(millis));
};
