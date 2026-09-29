/**
 * Purga los movimientos de prueba de jornadas concretas: ventas/comprobantes,
 * inventarios (con productos y movimientos), cortes y pedidos VIP.
 *
 * Dry-run por defecto. Antes de borrar siempre vuelca un respaldo JSON.
 *
 *   npx ts-node --transpile-only scripts/purge-jornadas-prueba.ts
 *   npx ts-node --transpile-only scripts/purge-jornadas-prueba.ts --apply
 *
 * Banderas:
 *   --apply          ejecuta el borrado (sin ella solo reporta)
 *   --strict         descarta coincidencias por "mismo día" sin jornadaId propio
 *   --vip            incluye VIP/palcos (pedidos, reservas y config del día)
 *   --asignaciones   incluye asignaciones_cajas_jornada (configuración de caja)
 *   --tickets        incluye la colección legacy `tickets`
 *   --jornada=<id>   agrega un jornadaId explícito al objetivo
 *
 * No importa los servicios del backend a propósito: `asignacion-caja.service`
 * arrastra `app.firebase.ts`, que exige credenciales de `app-oficial-leon`
 * que no hacen falta para esta limpieza.
 */
import "../src/config/env.bootstrap";
import * as fs from "fs";
import * as path from "path";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../src/config/firebase";
import { COLLECTIONS } from "../src/config/firestore.constants";

type Rama = "varonil" | "femenil";

/** `numeros` limita la purga a esas jornadas del día; vacío = todas. */
const TARGETS: Array<{ fecha: string; rama: Rama; numeros?: number[] }> = [
  { fecha: "2026-09-12", rama: "varonil", numeros: [8] },
  { fecha: "2026-09-14", rama: "varonil", numeros: [8] },
];

/**
 * Comprobantes que se conservan aunque cuelguen de un inventario objetivo.
 * El pedido VIP de abajo se pagó con tarjeta el 2026-09-08 (lleva su propio
 * `jornadaId: "2026-09-08"`) y solo quedó ligado al inventario de la J8.
 */
const KEEP_VENTAS = new Set<string>([
  "vip_3O5I4RqgNTxNvs3DmvCU_DNKNbnFxnfOey3bhb33h",
]);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const STRICT = args.includes("--strict");
// VIP se recolecta por fecha, así que en un día de partido real arrastraría
// pedidos y `vip_service_configs/<fecha>` que no son de prueba: opt-in.
const INCLUDE_VIP = args.includes("--vip");
const INCLUDE_ASIGNACIONES = args.includes("--asignaciones");
const INCLUDE_TICKETS = args.includes("--tickets");
const EXTRA_JORNADAS = args
  .filter((a) => a.startsWith("--jornada="))
  .map((a) => a.slice("--jornada=".length).trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Helpers de jornada (copia fiel de asignacion-caja.service / detalle-venta.service)
// ---------------------------------------------------------------------------

const JORNADA_ID_RE = /^(\d{4}-\d{2}-\d{2})__J(\d+)(?:__(femenil))?$/;
const MEXICO_TZ = "America/Mexico_City";

const normalizeRama = (rama?: unknown): Rama =>
  rama === "femenil" ? "femenil" : "varonil";

const buildJornadaId = (
  fecha: string,
  numero: number | string,
  rama: Rama,
): string =>
  rama === "femenil"
    ? `${fecha}__J${numero}__femenil`
    : `${fecha}__J${numero}`;

/** Como parseJornadaId del backend, pero devuelve null en vez de lanzar. */
const parseJornadaId = (
  jornadaId: string,
): { fecha: string; numero: number; rama: Rama } | null => {
  const match = String(jornadaId ?? "").trim().match(JORNADA_ID_RE);
  if (!match) return null;
  return {
    fecha: match[1],
    numero: Number(match[2]),
    rama: match[3] === "femenil" ? "femenil" : "varonil",
  };
};

const ramaFromId = (id?: string | null): Rama | null => {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  if (/(?:^|__)femenil(?:__|$)/.test(raw)) return "femenil";
  if (/^\d{4}-\d{2}-\d{2}__J\d+/.test(raw)) return "varonil";
  return null;
};

const ramaFromInventario = (
  data: Record<string, unknown> | null | undefined,
  inventarioId?: string | null,
): Rama => {
  if (data && typeof data === "object") {
    const raw = data.rama;
    if (raw === "femenil" || raw === "varonil") return normalizeRama(raw);
  }
  return ramaFromId(inventarioId ?? "") ?? "varonil";
};

const alignJornadaIdWithInventario = (
  jornadaId: string | null | undefined,
  inventarioId: string | null | undefined,
): string | null => {
  const invId = String(inventarioId ?? "").trim();
  const current = String(jornadaId ?? "").trim();
  const ramaInv = ramaFromId(invId);
  if (!ramaInv || !invId) return current || null;

  const parsed = parseJornadaId(current);
  if (parsed) {
    if (parsed.rama === ramaInv) return current;
    return buildJornadaId(parsed.fecha, parsed.numero, ramaInv);
  }

  const match = invId.match(/^(\d{4}-\d{2}-\d{2})__J(\d+)/);
  if (match) return buildJornadaId(match[1], Number(match[2]), ramaInv);
  return current || null;
};

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MEXICO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const toYmdMexico = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    const direct = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct) return direct[1];
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : ymdFormatter.format(parsed);
  }
  if (value instanceof Date) return ymdFormatter.format(value);
  if (typeof value === "object") {
    const obj = value as { toDate?: () => Date; seconds?: number };
    if (typeof obj.toDate === "function") return ymdFormatter.format(obj.toDate());
    if (typeof obj.seconds === "number") {
      return ymdFormatter.format(new Date(obj.seconds * 1000));
    }
  }
  return null;
};

const inventarioMatchesJornadaPrefix = (
  inventarioId: string,
  jornadaId: string,
): boolean => {
  if (inventarioId === jornadaId) return true;
  if (!inventarioId.startsWith(`${jornadaId}__`)) return false;
  const parsed = parseJornadaId(jornadaId);
  if (parsed && parsed.rama === "varonil") {
    const rest = inventarioId.slice(jornadaId.length + 2);
    if (rest === "femenil" || rest.startsWith("femenil__")) return false;
  }
  return true;
};

const ventaRamaHint = (venta: Record<string, unknown>): Rama | null => {
  const fromInv = ramaFromId(String(venta.inventarioId ?? ""));
  if (fromInv) return fromInv;
  const parsed = parseJornadaId(String(venta.jornadaId ?? ""));
  if (parsed) return parsed.rama;
  return ramaFromId(String(venta.jornadaId ?? ""));
};

type Reason = "jornadaId" | "vip-fecha" | "inventario" | "mismo-dia";

/**
 * Equivalente a matchesJornadaListFilter, pero devolviendo el motivo para que
 * el dry-run explique por qué cada documento entró a la purga.
 */
const classifyMatch = (
  row: Record<string, unknown>,
  target: string,
): Reason | null => {
  const t = String(target ?? "").trim();
  if (!t) return null;

  const parsed = parseJornadaId(t);
  const filterRama = parsed ? parsed.rama : null;
  const fechaJornada = parsed
    ? parsed.fecha
    : /^\d{4}-\d{2}-\d{2}$/.test(t)
      ? t
      : null;

  const inventarioId = String(row.inventarioId ?? "").trim();
  const rawJornadaId = String(row.jornadaId ?? "").trim();
  const aligned =
    alignJornadaIdWithInventario(rawJornadaId, inventarioId || null) ??
    rawJornadaId;

  if (aligned === t) return "jornadaId";

  if (fechaJornada) {
    if (aligned === fechaJornada || rawJornadaId === fechaJornada) {
      return "vip-fecha";
    }
    const fechaRow = toYmdMexico(row.fecha) ?? toYmdMexico(row.createdAt);
    if (fechaRow === fechaJornada) {
      // El documento ya declara otra jornada del mismo día: no es de este objetivo.
      const parsedRow = parseJornadaId(aligned);
      if (
        parsed &&
        parsedRow &&
        (parsedRow.numero !== parsed.numero || parsedRow.rama !== parsed.rama)
      ) {
        return null;
      }
      const hint = ventaRamaHint({
        ...row,
        jornadaId: aligned,
        inventarioId,
      });
      if (filterRama && hint && hint !== filterRama) return null;
      return "mismo-dia";
    }
  }

  if (inventarioId && inventarioMatchesJornadaPrefix(inventarioId, t)) {
    return "inventario";
  }
  return null;
};

// ---------------------------------------------------------------------------
// Utilidades genéricas
// ---------------------------------------------------------------------------

type Snap = FirebaseFirestore.QueryDocumentSnapshot;
type DocRef = FirebaseFirestore.DocumentReference;

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const collect = (target: Map<string, Snap>, docs: Snap[]): void => {
  for (const doc of docs) target.set(doc.ref.path, doc);
};

/** Rango UTC del día natural en hora de México (CST fijo, UTC-6). */
const dayRangeUtc = (fecha: string) => {
  const start = new Date(`${fecha}T06:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: Timestamp.fromDate(start), end: Timestamp.fromDate(end) };
};

const serialize = (value: unknown): unknown => {
  if (value == null) return value;
  if (value instanceof Timestamp) {
    return { __type: "timestamp", value: value.toDate().toISOString() };
  }
  if (value instanceof Date) {
    return { __type: "date", value: value.toISOString() };
  }
  if (Buffer.isBuffer(value)) {
    return { __type: "bytes", value: value.toString("base64") };
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof (obj as { path?: unknown }).path === "string" &&
        typeof (obj as { firestore?: unknown }).firestore === "object") {
      return { __type: "ref", value: String(obj.path) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = serialize(v);
    return out;
  }
  return value;
};

/** Vuelca un documento con sus subcolecciones (un nivel, que es lo que existe). */
const dumpDoc = async (ref: DocRef): Promise<Record<string, unknown>> => {
  const [snap, subcols] = await Promise.all([ref.get(), ref.listCollections()]);
  const subcollections: Record<string, unknown[]> = {};
  for (const sub of subcols) {
    const subSnap = await sub.get();
    subcollections[sub.id] = subSnap.docs.map((d) => ({
      id: d.id,
      data: serialize(d.data()),
    }));
  }
  return {
    path: ref.path,
    id: ref.id,
    data: serialize(snap.data() ?? null),
    subcollections,
  };
};

// ---------------------------------------------------------------------------
// Fase 1 · descubrir jornadas desde inventarios
// ---------------------------------------------------------------------------

interface JornadaObjetivo {
  fecha: string;
  rama: Rama;
  jornadaIds: string[];
  inventarios: Snap[];
}

const discoverJornada = async (
  fecha: string,
  rama: Rama,
  numeros?: number[],
): Promise<JornadaObjetivo> => {
  const soloNumeros = numeros?.length ? new Set(numeros) : null;
  const numeroDeInventario = (doc: Snap): number => {
    const declarado = Number(doc.data().jornada_numero ?? 0);
    if (declarado) return declarado;
    const fromId = doc.id.match(/^\d{4}-\d{2}-\d{2}__J(\d+)/);
    return fromId ? Number(fromId[1]) : 0;
  };

  const col = firestorePos.collection(COLLECTIONS.INVENTARIOS);
  const [byField, byId] = await Promise.all([
    col.where("jornada_fecha", "==", fecha).get(),
    // Inventarios legacy sin `jornada_fecha`: el id siempre empieza con la fecha.
    col
      .where(FieldPath.documentId(), ">=", `${fecha}__`)
      .where(FieldPath.documentId(), "<", `${fecha}__\uf8ff`)
      .get(),
  ]);

  const unique = new Map<string, Snap>();
  collect(unique, byField.docs);
  collect(unique, byId.docs);

  const inventarios = [...unique.values()].filter(
    (doc) =>
      ramaFromInventario(doc.data(), doc.id) === rama &&
      (!soloNumeros || soloNumeros.has(numeroDeInventario(doc))),
  );

  const jornadaIds = new Set<string>();
  for (const doc of inventarios) {
    const numero = numeroDeInventario(doc);
    if (numero) jornadaIds.add(buildJornadaId(fecha, numero, rama));
  }
  // Aunque no haya inventario, la jornada pedida debe purgarse.
  for (const numero of soloNumeros ?? []) {
    jornadaIds.add(buildJornadaId(fecha, numero, rama));
  }

  for (const extra of EXTRA_JORNADAS) {
    const parsed = parseJornadaId(extra);
    if (parsed && parsed.fecha === fecha && parsed.rama === rama) {
      if (soloNumeros && !soloNumeros.has(parsed.numero)) continue;
      jornadaIds.add(extra);
    }
  }

  return { fecha, rama, jornadaIds: [...jornadaIds], inventarios };
};

// ---------------------------------------------------------------------------
// Fase 2 · recolectar objetivos
// ---------------------------------------------------------------------------

interface Hallazgos {
  ventas: Map<string, Snap>;
  ventasMotivo: Map<string, Reason>;
  cortes: Map<string, Snap>;
  inventarios: Map<string, Snap>;
  vipOrders: Map<string, Snap>;
  vipReservations: Map<string, Snap>;
  vipServiceConfigs: Map<string, Snap>;
  vipRefundOps: Map<string, Snap>;
  vipIdempotency: Map<string, Snap>;
  abonado: Map<string, Snap>;
  loyalty: Map<string, Snap>;
  asignaciones: Map<string, Snap>;
  tickets: Map<string, Snap>;
}

const emptyHallazgos = (): Hallazgos => ({
  ventas: new Map(),
  ventasMotivo: new Map(),
  cortes: new Map(),
  inventarios: new Map(),
  vipOrders: new Map(),
  vipReservations: new Map(),
  vipServiceConfigs: new Map(),
  vipRefundOps: new Map(),
  vipIdempotency: new Map(),
  abonado: new Map(),
  loyalty: new Map(),
  asignaciones: new Map(),
  tickets: new Map(),
});

const collectVentas = async (
  objetivos: JornadaObjetivo[],
  out: Hallazgos,
): Promise<void> => {
  const col = firestorePos.collection(COLLECTIONS.COMPROBANTES_VENTA);
  const candidatos = new Map<string, Snap>();

  for (const objetivo of objetivos) {
    for (const jid of objetivo.jornadaIds) {
      const [porJornada, porInventario] = await Promise.all([
        col.where("jornadaId", "==", jid).get(),
        col
          .where("inventarioId", ">=", `${jid}__`)
          .where("inventarioId", "<", `${jid}__\uf8ff`)
          .get(),
      ]);
      collect(candidatos, porJornada.docs);
      collect(candidatos, porInventario.docs);
    }

    // VIP/palcos guardan solo la fecha en jornadaId.
    const porFecha = await col.where("jornadaId", "==", objetivo.fecha).get();
    collect(candidatos, porFecha.docs);

    if (!STRICT) {
      // Ventas cobradas ese día que no quedaron ligadas por jornadaId ni inventario.
      const { start, end } = dayRangeUtc(objetivo.fecha);
      const [porFechaTs, porCreatedAt] = await Promise.all([
        col.where("fecha", ">=", start).where("fecha", "<", end).get(),
        col.where("createdAt", ">=", start).where("createdAt", "<", end).get(),
      ]);
      collect(candidatos, porFechaTs.docs);
      collect(candidatos, porCreatedAt.docs);
    }
  }

  for (const doc of candidatos.values()) {
    if (KEEP_VENTAS.has(doc.id)) {
      console.log(`    (conservado por lista blanca) ${doc.id}`);
      continue;
    }
    const data = doc.data();
    for (const objetivo of objetivos) {
      const targets = objetivo.jornadaIds.length
        ? objetivo.jornadaIds
        : [objetivo.fecha];
      let reason: Reason | null = null;
      for (const target of targets) {
        reason = classifyMatch(data, target);
        if (reason) break;
      }
      if (!reason) continue;
      if (STRICT && reason === "mismo-dia") continue;
      out.ventas.set(doc.ref.path, doc);
      out.ventasMotivo.set(doc.ref.path, reason);
      break;
    }
  }
};

const collectCortes = async (
  objetivos: JornadaObjetivo[],
  out: Hallazgos,
): Promise<void> => {
  const col = firestorePos.collection(COLLECTIONS.CORTES);
  const candidatos = new Map<string, Snap>();

  for (const objetivo of objetivos) {
    for (const jid of objetivo.jornadaIds) {
      collect(candidatos, (await col.where("jornadaId", "==", jid).get()).docs);
    }
    // `cortes.fecha` es el día del cierre en formato YYYY-MM-DD.
    collect(candidatos, (await col.where("fecha", "==", objetivo.fecha).get()).docs);

    const invIds = objetivo.inventarios.map((d) => d.id);
    for (const grupo of chunk(invIds, 10)) {
      collect(candidatos, (await col.where("inventarioId", "in", grupo).get()).docs);
    }
  }

  for (const doc of candidatos.values()) {
    const data = doc.data();
    for (const objetivo of objetivos) {
      const targets = objetivo.jornadaIds.length
        ? objetivo.jornadaIds
        : [objetivo.fecha];
      let reason: Reason | null = null;
      for (const target of targets) {
        reason = classifyMatch(data, target);
        if (reason) break;
      }
      if (!reason) continue;
      if (STRICT && reason === "mismo-dia") continue;
      out.cortes.set(doc.ref.path, doc);
      break;
    }
  }
};

const collectVip = async (
  objetivos: JornadaObjetivo[],
  out: Hallazgos,
): Promise<void> => {
  const fechas = objetivos.map((o) => o.fecha);
  const inventarioIds = objetivos.flatMap((o) => o.inventarios.map((d) => d.id));

  const ordersCol = firestorePos.collection(COLLECTIONS.VIP_ORDERS);
  const reservCol = firestorePos.collection(COLLECTIONS.VIP_RESERVATIONS);

  for (const grupo of chunk(fechas, 10)) {
    collect(out.vipOrders, (await ordersCol.where("fecha", "in", grupo).get()).docs);
    collect(out.vipReservations, (await reservCol.where("fecha", "in", grupo).get()).docs);
  }

  // Reservas atadas a un inventario de la jornada aunque la fecha del pedido difiera.
  for (const grupo of chunk(inventarioIds, 10)) {
    collect(
      out.vipReservations,
      (await reservCol.where("inventoryId", "in", grupo).get()).docs,
    );
  }

  const orderIds = new Set<string>();
  for (const doc of out.vipOrders.values()) orderIds.add(doc.id);
  for (const doc of out.vipReservations.values()) {
    const orderId = String(doc.data().orderId ?? "").trim();
    if (orderId) orderIds.add(orderId);
  }

  // Pedidos alcanzados solo por sus reservas.
  for (const grupo of chunk([...orderIds], 10)) {
    const faltantes = grupo.filter(
      (id) => !out.vipOrders.has(`${COLLECTIONS.VIP_ORDERS}/${id}`),
    );
    if (!faltantes.length) continue;
    collect(
      out.vipOrders,
      (await ordersCol.where(FieldPath.documentId(), "in", faltantes).get()).docs,
    );
  }

  // Reservas de esos pedidos que no se hayan alcanzado por fecha/inventario.
  for (const grupo of chunk([...orderIds], 10)) {
    collect(
      out.vipReservations,
      (await reservCol.where("orderId", "in", grupo).get()).docs,
    );
  }

  // vip_service_configs usa la fecha como id. `default` es config global.
  const configsCol = firestorePos.collection(COLLECTIONS.VIP_SERVICE_CONFIGS);
  for (const fecha of fechas) {
    if (fecha === "default") continue;
    const snap = await configsCol.doc(fecha).get();
    if (snap.exists) out.vipServiceConfigs.set(snap.ref.path, snap as Snap);
  }

  // vip_refund_operations usa el orderId como id de documento.
  const refundCol = firestorePos.collection(COLLECTIONS.VIP_REFUND_OPERATIONS);
  for (const orderId of orderIds) {
    const snap = await refundCol.doc(orderId).get();
    if (snap.exists) out.vipRefundOps.set(snap.ref.path, snap as Snap);
  }

  const idemCol = firestorePos.collection(COLLECTIONS.VIP_IDEMPOTENCY);
  for (const grupo of chunk([...orderIds], 10)) {
    collect(out.vipIdempotency, (await idemCol.where("orderId", "in", grupo).get()).docs);
  }
};

const collectDerivados = async (
  objetivos: JornadaObjetivo[],
  out: Hallazgos,
): Promise<void> => {
  const jornadaIds = objetivos.flatMap((o) => o.jornadaIds);
  const fechas = objetivos.map((o) => o.fecha);
  const claves = [...new Set([...jornadaIds, ...fechas])];

  const abonadoCol = firestorePos.collection(
    COLLECTIONS.ABONADO_BENEFICIOS_CONSUMIDOS,
  );
  for (const grupo of chunk(claves, 10)) {
    collect(out.abonado, (await abonadoCol.where("jornadaId", "in", grupo).get()).docs);
  }

  const ventaIds = [
    ...new Set(
      [...out.ventas.values()]
        .map((doc) => String(doc.data().ventaId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const loyaltyCol = firestorePos.collection(
    COLLECTIONS.LOYALTY_OPERACIONES_PENDIENTES,
  );
  for (const grupo of chunk(ventaIds, 10)) {
    collect(out.loyalty, (await loyaltyCol.where("ventaId", "in", grupo).get()).docs);
  }

  if (INCLUDE_ASIGNACIONES && jornadaIds.length) {
    const asigCol = firestorePos.collection(
      COLLECTIONS.ASIGNACIONES_CAJAS_JORNADA,
    );
    for (const grupo of chunk(jornadaIds, 10)) {
      collect(
        out.asignaciones,
        (await asigCol.where("jornadaId", "in", grupo).get()).docs,
      );
    }
  }

  if (INCLUDE_TICKETS) {
    const ticketsCol = firestorePos.collection(COLLECTIONS.TICKETS);
    for (const fecha of fechas) {
      const { start, end } = dayRangeUtc(fecha);
      const [porTs, porString] = await Promise.all([
        ticketsCol.where("fecha", ">=", start).where("fecha", "<", end).get(),
        ticketsCol.where("fecha", "==", fecha).get(),
      ]);
      collect(out.tickets, porTs.docs);
      collect(out.tickets, porString.docs);
    }
  }
};

// ---------------------------------------------------------------------------
// Reporte, respaldo y borrado
// ---------------------------------------------------------------------------

const GRUPOS: Array<{
  key: keyof Hallazgos;
  label: string;
  recursivo: boolean;
}> = [
  { key: "ventas", label: "comprobantes_venta (+detalle)", recursivo: true },
  { key: "inventarios", label: "inventarios (+productos +movimientos)", recursivo: true },
  { key: "cortes", label: "cortes", recursivo: false },
  { key: "vipOrders", label: "vip_orders (+events)", recursivo: true },
  { key: "vipReservations", label: "vip_reservations", recursivo: false },
  { key: "vipServiceConfigs", label: "vip_service_configs", recursivo: false },
  { key: "vipRefundOps", label: "vip_refund_operations", recursivo: false },
  { key: "vipIdempotency", label: "vip_idempotency", recursivo: false },
  { key: "abonado", label: "abonado_beneficios_consumidos", recursivo: false },
  { key: "loyalty", label: "loyalty_operaciones_pendientes", recursivo: false },
  { key: "asignaciones", label: "asignaciones_cajas_jornada", recursivo: false },
  { key: "tickets", label: "tickets (legacy)", recursivo: false },
];

const grupoDocs = (hallazgos: Hallazgos, key: keyof Hallazgos): Snap[] =>
  [...(hallazgos[key] as Map<string, Snap>).values()];

async function main(): Promise<void> {
  console.log("\n=== Purga de jornadas de prueba ===");
  console.log(`Modo:      ${APPLY ? "APLICAR (borra datos)" : "DRY-RUN (solo reporta)"}`);
  console.log(`Base:      ${COLLECTIONS.CONCESIONES} / proyecto POS`);
  console.log(
    `Opciones:  strict=${STRICT} vip=${INCLUDE_VIP} ` +
      `asignaciones=${INCLUDE_ASIGNACIONES} tickets=${INCLUDE_TICKETS}`,
  );

  // Fase 1
  const objetivos: JornadaObjetivo[] = [];
  for (const target of TARGETS) {
    objetivos.push(
      await discoverJornada(target.fecha, target.rama, target.numeros),
    );
  }

  console.log("\n--- Jornadas detectadas ---");
  for (const objetivo of objetivos) {
    console.log(
      `${objetivo.fecha} ${objetivo.rama}: ` +
        `jornadaIds=[${objetivo.jornadaIds.join(", ") || "ninguno"}] ` +
        `inventarios=${objetivo.inventarios.length}`,
    );
    for (const inv of objetivo.inventarios) {
      const data = inv.data();
      console.log(
        `    · ${inv.id}  (sucursal=${data.sucursal_id ?? "?"}, activo=${data.activo})`,
      );
    }
  }

  // Fase 2
  const hallazgos = emptyHallazgos();
  for (const objetivo of objetivos) {
    collect(hallazgos.inventarios, objetivo.inventarios);
  }
  await collectVentas(objetivos, hallazgos);
  await collectCortes(objetivos, hallazgos);
  if (INCLUDE_VIP) await collectVip(objetivos, hallazgos);
  await collectDerivados(objetivos, hallazgos);

  console.log("\n--- Documentos a borrar ---");
  let total = 0;
  for (const grupo of GRUPOS) {
    const docs = grupoDocs(hallazgos, grupo.key);
    total += docs.length;
    console.log(`${String(docs.length).padStart(5)}  ${grupo.label}`);
  }
  console.log(`${String(total).padStart(5)}  TOTAL`);

  if (hallazgos.ventas.size) {
    const porMotivo = new Map<Reason, number>();
    for (const reason of hallazgos.ventasMotivo.values()) {
      porMotivo.set(reason, (porMotivo.get(reason) ?? 0) + 1);
    }
    console.log("\n--- Ventas por motivo de coincidencia ---");
    for (const [reason, count] of porMotivo) {
      console.log(`${String(count).padStart(5)}  ${reason}`);
    }
    console.log("\n--- Muestra de ventas ---");
    for (const doc of [...hallazgos.ventas.values()].slice(0, 15)) {
      const data = doc.data();
      console.log(
        `    · ${doc.id} venta=${data.ventaId ?? "?"} total=${data.total ?? 0} ` +
          `jornada=${data.jornadaId ?? "-"} inv=${data.inventarioId ?? "-"} ` +
          `motivo=${hallazgos.ventasMotivo.get(doc.ref.path)}`,
      );
    }
    if (hallazgos.ventas.size > 15) {
      console.log(`    … y ${hallazgos.ventas.size - 15} más`);
    }
  }

  if (total === 0) {
    console.log("\nNo hay nada que borrar.");
    return;
  }

  // Fase 3 · respaldo
  const tmpDir = path.resolve(__dirname, "..", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(tmpDir, `purge-backup-${stamp}.json`);

  console.log("\n--- Generando respaldo ---");
  const backup: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    apply: APPLY,
    options: {
      strict: STRICT,
      vip: INCLUDE_VIP,
      asignaciones: INCLUDE_ASIGNACIONES,
      tickets: INCLUDE_TICKETS,
      extraJornadas: EXTRA_JORNADAS,
    },
    objetivos: objetivos.map((o) => ({
      fecha: o.fecha,
      rama: o.rama,
      jornadaIds: o.jornadaIds,
      inventarioIds: o.inventarios.map((d) => d.id),
    })),
    grupos: {} as Record<string, unknown[]>,
  };

  for (const grupo of GRUPOS) {
    const docs = grupoDocs(hallazgos, grupo.key);
    if (!docs.length) continue;
    const dumps: unknown[] = [];
    for (const doc of docs) dumps.push(await dumpDoc(doc.ref));
    (backup.grupos as Record<string, unknown[]>)[grupo.key] = dumps;
    console.log(`    · ${grupo.label}: ${dumps.length}`);
  }

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log(`Respaldo escrito en: ${backupPath}`);

  if (!APPLY) {
    console.log(
      "\nDRY-RUN: no se borró nada. Revisa el reporte y vuelve a correr con --apply.",
    );
    return;
  }

  // Fase 4 · borrado
  console.log("\n--- Borrando ---");
  for (const grupo of GRUPOS) {
    const docs = grupoDocs(hallazgos, grupo.key);
    if (!docs.length) continue;

    if (grupo.recursivo) {
      for (const doc of docs) await firestorePos.recursiveDelete(doc.ref);
    } else {
      const writer = firestorePos.bulkWriter();
      for (const doc of docs) writer.delete(doc.ref);
      await writer.close();
    }
    console.log(`    · ${grupo.label}: ${docs.length} borrados`);
  }

  console.log(`\nListo. ${total} documento(s) borrados.`);
  console.log(`Respaldo recuperable en: ${backupPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
