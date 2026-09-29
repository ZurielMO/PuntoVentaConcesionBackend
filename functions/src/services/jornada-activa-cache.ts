import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import type { JornadaRama } from "./asignacion-caja.service";

type JornadaInput = {
  activo?: boolean;
  rama?: string;
  jornada?: unknown;
  fecha?: unknown;
  hora?: unknown;
  equipo_local?: unknown;
  equipo_visitante?: unknown;
  estadio?: unknown;
};

export type RememberedJornada = {
  activo: true;
  rama: JornadaRama;
  jornada: number;
  fecha: string;
  hora: string;
  equipo_local?: string;
  equipo_visitante?: string;
  estadio?: string;
};

const cacheCol = () => firestorePos.collection(COLLECTIONS.JORNADA_ACTIVA_CACHE);

const toIsoDate = (fecha: unknown): string | null => {
  const raw = String(fecha ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
};

const text = (value: unknown): string | null => {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.slice(0, 80) : null;
};

/** Misma jornada si coinciden la fecha y el número, sin importar el formato de la fecha. */
export const jornadaMatchKey = (fecha: unknown, numero: unknown): string | null => {
  const date = toIsoDate(fecha);
  const parsed = Number(numero);
  if (!date || !Number.isInteger(parsed) || parsed <= 0) return null;
  return `${date}__${parsed}`;
};

const snapshotOf = (row: JornadaInput, rama: JornadaRama) => ({
  activo: true,
  rama,
  jornada: Number(row.jornada),
  fecha: String(row.fecha),
  hora: String(row.hora),
  equipo_local: text(row.equipo_local),
  equipo_visitante: text(row.equipo_visitante),
  estadio: text(row.estadio),
  updatedAt: FieldValue.serverTimestamp(),
});

/**
 * Conserva la última jornada con hora de inicio. No pisa el respaldo si el
 * nodo nuevo todavía no trae hora: un fallo a medias no borra el pitido.
 */
export const rememberJornadasActivas = async (
  activas: Record<string, JornadaInput>,
): Promise<void> => {
  const writes: Array<Promise<unknown>> = [];
  for (const rama of ["varonil", "femenil"] as const) {
    const row = Object.values(activas).find(
      (candidate) => candidate?.activo === true && candidate.rama === rama && text(candidate.hora),
    );
    if (!row?.fecha || row.jornada == null) continue;
    writes.push(cacheCol().doc(rama).set(snapshotOf(row, rama)));
  }
  await Promise.all(writes);
};

export const loadRememberedJornadaActiva = async (
  rama: JornadaRama,
): Promise<RememberedJornada | null> => {
  const doc = await cacheCol().doc(rama).get();
  if (!doc.exists) return null;
  const data = doc.data() || {};
  if (data.activo === false || !text(data.hora) || data.jornada == null || !toIsoDate(data.fecha)) {
    return null;
  }
  return {
    activo: true,
    rama,
    jornada: Number(data.jornada),
    fecha: String(data.fecha),
    hora: String(data.hora),
    equipo_local: text(data.equipo_local) ?? undefined,
    equipo_visitante: text(data.equipo_visitante) ?? undefined,
    estadio: text(data.estadio) ?? undefined,
  };
};

/** Completa hora y equipos solo cuando el respaldo es el mismo partido. */
export const applyRememberedDetails = <T extends JornadaInput>(
  row: T,
  remembered: RememberedJornada | null,
): T => {
  if (!remembered) return row;
  if (jornadaMatchKey(row.fecha, row.jornada) !== jornadaMatchKey(remembered.fecha, remembered.jornada)) {
    return row;
  }
  return {
    ...row,
    hora: text(row.hora) ?? remembered.hora,
    equipo_local: text(row.equipo_local) ?? remembered.equipo_local,
    equipo_visitante: text(row.equipo_visitante) ?? remembered.equipo_visitante,
    estadio: text(row.estadio) ?? remembered.estadio,
  };
};
