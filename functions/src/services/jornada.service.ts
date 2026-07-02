import { getRealtimeDbAppOficial2 } from "../config/firebase.appoficial2";
import { ApiError } from "../utils/api-error";

const JORNADA_ACTIVA_PATH = "jornada_activa";

export interface JornadaActivaValue {
  activo?: boolean;
  equipo_local?: string;
  equipo_visitante?: string;
  estadio?: string;
  fecha?: string;
  hora?: string;
  jornada?: number;
  [key: string]: unknown;
}

/**
 * Devuelve el nodo `jornada_activa` filtrando solo las llaves con activo=true.
 * Respuesta en forma { [key]: JornadaActivaValue }.
 */
export const getJornadaActiva = async (): Promise<
  Record<string, JornadaActivaValue>
> => {
  const db = getRealtimeDbAppOficial2();
  const snapshot = await db.ref(JORNADA_ACTIVA_PATH).get();

  if (!snapshot.exists()) {
    return {};
  }

  const value = snapshot.val() as Record<string, JornadaActivaValue>;

  const activas: Record<string, JornadaActivaValue> = {};
  for (const [key, jornada] of Object.entries(value)) {
    if (jornada && jornada.activo === true) {
      activas[key] = jornada;
    }
  }

  // Fallback: si ninguna marca activo=true, devolver el nodo completo.
  return Object.keys(activas).length > 0 ? activas : value;
};

const normalizeFechaJornada = (fecha: string): string => {
  const raw = fecha.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return raw;
};

/** Primera jornada con activo=true; usa jornada y fecha para abrir inventario. */
export const resolveJornadaPrimaria = async (): Promise<{
  jornadaNumero: number;
  fecha: string;
  detalle: JornadaActivaValue;
}> => {
  const activas = await getJornadaActiva();
  const entries = Object.values(activas).filter(Boolean);
  const pick =
    entries.find((j) => j.activo === true) ?? entries[0];

  if (!pick || pick.jornada == null || !pick.fecha) {
    throw new ApiError(
      400,
      "No hay jornada activa configurada",
      true,
      "JORNADA_NO_ACTIVA",
    );
  }

  return {
    jornadaNumero: Number(pick.jornada),
    fecha: normalizeFechaJornada(String(pick.fecha)),
    detalle: pick,
  };
};
