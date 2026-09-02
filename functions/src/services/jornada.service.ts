import { firestorePos } from "../config/firebase";
import { getRealtimeDbAppOficial2 } from "../config/firebase.appoficial2";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import {
  buildJornadaId,
  normalizeRama,
  parseJornadaId,
  ramaFromId,
  type JornadaRama,
} from "./asignacion-caja.service";
import { normalizeFecha } from "./inventario.service";

const JORNADA_ACTIVA_PATH = "jornada_activa";
const JORNADA_ACTIVA_FEMENIL_PATH = "jornada_activa_femenil";

export type { JornadaRama };
export { normalizeRama, parseJornadaId, buildJornadaId };

export interface JornadaActivaValue {
  activo?: boolean;
  equipo_local?: string;
  equipo_visitante?: string;
  estadio?: string;
  fecha?: string;
  hora?: string;
  jornada?: number;
  rama?: JornadaRama;
  [key: string]: unknown;
}

const normalizeFechaJornada = (fecha: string): string => {
  const raw = fecha.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return raw;
};

const readNodoActivo = async (
  path: string,
  rama: JornadaRama,
): Promise<Record<string, JornadaActivaValue>> => {
  const db = getRealtimeDbAppOficial2();
  const snapshot = await db.ref(path).get();

  if (!snapshot.exists()) {
    return {};
  }

  const value = snapshot.val() as Record<string, JornadaActivaValue>;
  const activas: Record<string, JornadaActivaValue> = {};
  for (const [key, jornada] of Object.entries(value)) {
    if (jornada && jornada.activo === true) {
      activas[`${rama}:${key}`] = { ...jornada, rama };
    }
  }

  // Solo jornadas con activo===true. No reinyectar el nodo completo:
  // eso marcaba Varonil desactivado como "activa" y contaminaba selects.
  return activas;
};

/**
 * Une `jornada_activa` + `jornada_activa_femenil`.
 * Claves prefijadas (`varonil:Jornada6`) para evitar colisiones.
 */
export const getJornadaActiva = async (): Promise<
  Record<string, JornadaActivaValue>
> => {
  const [varonil, femenil] = await Promise.all([
    readNodoActivo(JORNADA_ACTIVA_PATH, "varonil"),
    readNodoActivo(JORNADA_ACTIVA_FEMENIL_PATH, "femenil"),
  ]);
  return { ...varonil, ...femenil };
};

/** Primera entrada con activo===true de una rama (o null). */
export const pickJornadaActivaPorRama = (
  activas: Record<string, JornadaActivaValue>,
  rama: JornadaRama,
): JornadaActivaValue | null => {
  const entries = Object.values(activas).filter(
    (j) => j && normalizeRama(j.rama) === rama && j.activo === true,
  );
  if (entries.length === 0) return null;
  return entries[0];
};

export const getJornadasActivasPorRama = async (): Promise<{
  varonil: JornadaActivaValue | null;
  femenil: JornadaActivaValue | null;
}> => {
  const activas = await getJornadaActiva();
  return {
    varonil: pickJornadaActivaPorRama(activas, "varonil"),
    femenil: pickJornadaActivaPorRama(activas, "femenil"),
  };
};

/** Resuelve la jornada activa RTDB de la rama indicada. */
export const resolveJornadaActiva = async (
  ramaInput: JornadaRama | string = "varonil",
): Promise<{
  jornadaNumero: number;
  fecha: string;
  rama: JornadaRama;
  detalle: JornadaActivaValue;
}> => {
  const rama = normalizeRama(ramaInput);
  const activas = await getJornadaActiva();
  const pick = pickJornadaActivaPorRama(activas, rama);

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
    rama,
    detalle: { ...pick, rama },
  };
};

/** @deprecated Preferir resolveJornadaActiva(rama). Alias varonil. */
export const resolveJornadaPrimaria = async (): Promise<{
  jornadaNumero: number;
  fecha: string;
  detalle: JornadaActivaValue;
}> => {
  const result = await resolveJornadaActiva("varonil");
  return {
    jornadaNumero: result.jornadaNumero,
    fecha: result.fecha,
    detalle: result.detalle,
  };
};

export interface JornadaDisponible {
  jornadaId: string;
  fecha: string;
  numero: number;
  rama: JornadaRama;
  etiqueta: string;
}

export const formatEtiquetaJornada = (
  fecha: string,
  numero: number,
  rama: JornadaRama = "varonil",
) => {
  const [y, m, d] = fecha.split("-");
  const ramaLabel = rama === "femenil" ? "Femenil" : "Varonil";
  return `Jornada ${numero} · ${d}/${m}/${y} · ${ramaLabel}`;
};

/** Jornadas con inventarios registrados (histórico: abiertos y cerrados). */
export const listJornadasDisponibles = async (filters?: {
  concesionId?: string;
  sucursalId?: string;
  rama?: JornadaRama;
}): Promise<JornadaDisponible[]> => {
  let query: FirebaseFirestore.Query = firestorePos.collection(
    COLLECTIONS.INVENTARIOS,
  );

  if (filters?.concesionId) {
    query = query.where("concesion_id", "==", filters.concesionId);
  }

  const snap = await query.get();
  let inventarios: Array<Record<string, unknown> & { id: string }> =
    snap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Record<string, unknown>),
    }));

  if (filters?.sucursalId) {
    inventarios = inventarios.filter(
      (inv) => inv.sucursal_id === filters.sucursalId,
    );
  }

  // Activas RTDB: inferir rama en inventarios legacy y asegurar que aparezcan.
  const activasPorClave = new Map<string, JornadaRama>();
  try {
    const porRama = await getJornadasActivasPorRama();
    for (const rama of ["varonil", "femenil"] as const) {
      const j = porRama[rama];
      if (!j?.fecha || j.jornada == null) continue;
      // Solo claves realmente activas (getJornadasActivasPorRama ya exige activo).
      if (j.activo !== true) continue;
      const fecha = normalizeFecha(String(j.fecha));
      activasPorClave.set(`${fecha}__${Number(j.jornada)}`, rama);
    }
  } catch {
    // Si RTDB no está disponible, seguimos solo con inventarios.
  }

  const resolveInvRama = (inv: Record<string, unknown>): {
    rama: JornadaRama;
    explicit: boolean;
  } => {
    const rawRama = inv.rama;
    if (rawRama === "femenil" || rawRama === "varonil") {
      return { rama: normalizeRama(rawRama as string), explicit: true };
    }
    const fromId = ramaFromId(String(inv.id ?? ""));
    if (fromId) {
      // Id con/sin __femenil es evidencia real del inventario (historial contable).
      return { rama: fromId, explicit: true };
    }
    const fechaRaw = String(inv.jornada_fecha ?? "");
    const numero = Number(inv.jornada_numero ?? 0);
    const fecha = fechaRaw ? normalizeFecha(fechaRaw) : "";
    const clave = fecha && numero ? `${fecha}__${numero}` : "";
    return {
      rama: (clave && activasPorClave.get(clave)) || "varonil",
      explicit: false,
    };
  };

  if (filters?.rama) {
    const ramaFilter = normalizeRama(filters.rama);
    inventarios = inventarios.filter(
      (inv) => resolveInvRama(inv).rama === ramaFilter,
    );
  }

  const byJornada = new Map<
    string,
    { fecha: string; numero: number; rama: JornadaRama }
  >();

  for (const inv of inventarios) {
    const fechaRaw = String(inv.jornada_fecha ?? "");
    const numero = Number(inv.jornada_numero ?? 0);
    if (!fechaRaw || !numero) continue;

    const fecha = normalizeFecha(fechaRaw);
    const { rama } = resolveInvRama(inv);
    const jornadaId = buildJornadaId(fecha, numero, rama);
    byJornada.set(jornadaId, { fecha, numero, rama });
  }

  // Incluir jornadas activas aunque aún no tengan inventarios.
  for (const [clave, rama] of activasPorClave.entries()) {
    const [fecha, numStr] = clave.split("__");
    const numero = Number(numStr);
    if (!fecha || !numero) continue;
    if (filters?.rama && normalizeRama(filters.rama) !== rama) continue;
    const jornadaId = buildJornadaId(fecha, numero, rama);
    if (!byJornada.has(jornadaId)) {
      byJornada.set(jornadaId, { fecha, numero, rama });
    }
  }

  /**
   * ¿Hay contabilidad real (ventas/cortes) para esta jornada varonil?
   * Ignora ventas mal etiquetadas cuyo inventario es femenil.
   */
  const hasVaronilAccounting = async (jornadaId: string): Promise<boolean> => {
    const isFemenilInv = (inventarioId: string) => {
      const rest = inventarioId.startsWith(`${jornadaId}__`)
        ? inventarioId.slice(jornadaId.length + 2)
        : inventarioId;
      return rest === "femenil" || rest.startsWith("femenil__");
    };

    const ventasSnap = await firestorePos
      .collection(COLLECTIONS.COMPROBANTES_VENTA)
      .where("jornadaId", "==", jornadaId)
      .limit(25)
      .get();
    for (const doc of ventasSnap.docs) {
      const invId = String(doc.data().inventarioId ?? "");
      if (!invId || !isFemenilInv(invId)) return true;
    }

    const invPrefixSnap = await firestorePos
      .collection(COLLECTIONS.COMPROBANTES_VENTA)
      .where("inventarioId", ">=", `${jornadaId}__`)
      .where("inventarioId", "<", `${jornadaId}__\uf8ff`)
      .limit(25)
      .get();
    for (const doc of invPrefixSnap.docs) {
      const invId = String(doc.data().inventarioId ?? "");
      if (invId.startsWith(`${jornadaId}__`) && !isFemenilInv(invId)) {
        return true;
      }
    }

    const cortesSnap = await firestorePos
      .collection(COLLECTIONS.CORTES)
      .where("jornadaId", "==", jornadaId)
      .limit(5)
      .get();
    if (!cortesSnap.empty) return true;

    return false;
  };

  // Quitar varonil fantasma: misma fecha/número que femenil, no activa en RTDB,
  // y sin ventas/cortes reales de esa rama. Conserva historial contable.
  for (const [id, data] of [...byJornada.entries()]) {
    if (data.rama !== "varonil") continue;
    const femenilId = buildJornadaId(data.fecha, data.numero, "femenil");
    if (!byJornada.has(femenilId)) continue;
    const claveActiva = `${data.fecha}__${data.numero}`;
    if (activasPorClave.get(claveActiva) === "varonil") continue;
    const hasAccounting = await hasVaronilAccounting(id);
    if (!hasAccounting) {
      byJornada.delete(id);
    }
  }

  return Array.from(byJornada.entries())
    .map(([jornadaId, { fecha, numero, rama }]) => ({
      jornadaId,
      fecha,
      numero,
      rama,
      etiqueta: formatEtiquetaJornada(fecha, numero, rama),
    }))
    .sort(
      (a, b) =>
        b.fecha.localeCompare(a.fecha) ||
        b.numero - a.numero ||
        a.rama.localeCompare(b.rama),
    );
};

/** Resuelve jornada para reportes: prioriza jornadaId explícito, luego inventarios, luego RTDB. */
export const resolveJornadaParaReporte = async (params: {
  jornadaId?: string;
  fecha?: string;
  jornadaNumero?: number;
  rama?: JornadaRama | string;
  concesionId?: string;
  sucursalId?: string;
}): Promise<{
  fecha: string;
  numero: number;
  rama: JornadaRama;
  jornadaId: string;
}> => {
  if (params.jornadaId) {
    const parsed = parseJornadaId(params.jornadaId);
    return {
      ...parsed,
      jornadaId: buildJornadaId(parsed.fecha, parsed.numero, parsed.rama),
    };
  }

  if (params.fecha && params.jornadaNumero != null) {
    const fecha = normalizeFecha(params.fecha);
    const numero = Number(params.jornadaNumero);
    const rama = normalizeRama(params.rama);
    return {
      fecha,
      numero,
      rama,
      jornadaId: buildJornadaId(fecha, numero, rama),
    };
  }

  const disponibles = await listJornadasDisponibles({
    concesionId: params.concesionId,
    sucursalId: params.sucursalId,
    rama: params.rama ? normalizeRama(params.rama) : undefined,
  });
  if (disponibles.length > 0) {
    const pick = disponibles[0];
    return {
      fecha: pick.fecha,
      numero: pick.numero,
      rama: pick.rama,
      jornadaId: pick.jornadaId,
    };
  }

  const rama = normalizeRama(params.rama);
  try {
    const activa = await resolveJornadaActiva(rama);
    return {
      fecha: activa.fecha,
      numero: activa.jornadaNumero,
      rama: activa.rama,
      jornadaId: buildJornadaId(activa.fecha, activa.jornadaNumero, activa.rama),
    };
  } catch {
    if (rama === "varonil") {
      const femenil = await resolveJornadaActiva("femenil");
      return {
        fecha: femenil.fecha,
        numero: femenil.jornadaNumero,
        rama: femenil.rama,
        jornadaId: buildJornadaId(
          femenil.fecha,
          femenil.jornadaNumero,
          femenil.rama,
        ),
      };
    }
    throw new ApiError(
      400,
      "No hay jornada activa configurada",
      true,
      "JORNADA_NO_ACTIVA",
    );
  }
};
