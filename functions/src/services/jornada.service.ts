import { getRealtimeDbAppOficial2 } from "../config/firebase.appoficial2";

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
