import { firestorePos } from "../config/firebase";
import { getRealtimeDbAppOficial2 } from "../config/firebase.appoficial2";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { buildJornadaId } from "./asignacion-caja.service";
import { normalizeFecha } from "./inventario.service";

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

const JORNADA_ID_RE = /^(\d{4}-\d{2}-\d{2})__J(\d+)$/;

export interface JornadaDisponible {
  jornadaId: string;
  fecha: string;
  numero: number;
  etiqueta: string;
}

const formatEtiquetaJornada = (fecha: string, numero: number) => {
  const [y, m, d] = fecha.split("-");
  return `Jornada ${numero} · ${d}/${m}/${y}`;
};

/** Parsea `2026-07-10__J1` → fecha + número de jornada. */
export const parseJornadaId = (
  jornadaId: string,
): { fecha: string; numero: number } => {
  const match = jornadaId.trim().match(JORNADA_ID_RE);
  if (!match) {
    throw new ApiError(400, "jornadaId inválido", true, "INVALID_JORNADA_ID");
  }
  return { fecha: match[1], numero: Number(match[2]) };
};

/** Jornadas con inventarios registrados (histórico consultable en cortes). */
export const listJornadasDisponibles = async (filters?: {
  concesionId?: string;
  sucursalId?: string;
}): Promise<JornadaDisponible[]> => {
  let query: FirebaseFirestore.Query = firestorePos
    .collection(COLLECTIONS.INVENTARIOS)
    .where("activo", "==", true);

  if (filters?.concesionId) {
    query = query.where("concesion_id", "==", filters.concesionId);
  }

  const snap = await query.get();
  let inventarios = snap.docs.map((doc) => doc.data());

  if (filters?.sucursalId) {
    inventarios = inventarios.filter(
      (inv) => inv.sucursal_id === filters.sucursalId,
    );
  }

  const byJornada = new Map<string, { fecha: string; numero: number }>();

  for (const inv of inventarios) {
    const fechaRaw = String(inv.jornada_fecha ?? "");
    const numero = Number(inv.jornada_numero ?? 0);
    if (!fechaRaw || !numero) continue;

    const fecha = normalizeFecha(fechaRaw);
    const jornadaId = buildJornadaId(fecha, numero);
    byJornada.set(jornadaId, { fecha, numero });
  }

  return Array.from(byJornada.entries())
    .map(([jornadaId, { fecha, numero }]) => ({
      jornadaId,
      fecha,
      numero,
      etiqueta: formatEtiquetaJornada(fecha, numero),
    }))
    .sort(
      (a, b) =>
        b.fecha.localeCompare(a.fecha) || b.numero - a.numero,
    );
};

/** Resuelve jornada para reportes: prioriza jornadaId explícito, luego inventarios, luego RTDB activa. */
export const resolveJornadaParaReporte = async (params: {
  jornadaId?: string;
  fecha?: string;
  jornadaNumero?: number;
  concesionId?: string;
  sucursalId?: string;
}): Promise<{ fecha: string; numero: number; jornadaId: string }> => {
  if (params.jornadaId) {
    const parsed = parseJornadaId(params.jornadaId);
    return {
      ...parsed,
      jornadaId: buildJornadaId(parsed.fecha, parsed.numero),
    };
  }

  if (params.fecha && params.jornadaNumero != null) {
    const fecha = normalizeFecha(params.fecha);
    const numero = Number(params.jornadaNumero);
    return {
      fecha,
      numero,
      jornadaId: buildJornadaId(fecha, numero),
    };
  }

  const disponibles = await listJornadasDisponibles({
    concesionId: params.concesionId,
    sucursalId: params.sucursalId,
  });
  if (disponibles.length > 0) {
    const pick = disponibles[0];
    return {
      fecha: pick.fecha,
      numero: pick.numero,
      jornadaId: pick.jornadaId,
    };
  }

  const primaria = await resolveJornadaPrimaria();
  return {
    fecha: primaria.fecha,
    numero: primaria.jornadaNumero,
    jornadaId: buildJornadaId(primaria.fecha, primaria.jornadaNumero),
  };
};
