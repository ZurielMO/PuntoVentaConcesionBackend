import { createHash } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import * as detalleVentaService from "./detalle-venta.service";
import * as productService from "./product.service";
import * as comboService from "./combo.service";
import * as concessionService from "./concession.service";
import { buildJornadaId } from "./asignacion-caja.service";
import { resolveJornadaPrimaria } from "./jornada.service";
import type { OperationalListFilters } from "../utils/list-filters.util";
import type { CorteScopeFilters } from "../domain/cortes/corte-scope";
import {
  adaptarCortePersistido,
  calcularComprobantes,
  crearSnapshotCorte,
  normalizarComprobanteLegacy,
  roundMoney,
  type CorteCalculationResult,
} from "../domain/cortes/corte-calculator";

const col = () => firestorePos.collection(COLLECTIONS.CORTES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> & { id: string } => ({
  id: doc.id,
  ...doc.data(),
});

export interface CorteListFilters extends OperationalListFilters {
  jornadaId?: string;
  sesionCajaId?: string;
  businessDate?: string;
  limit?: number;
}

const timestampMillis = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value && typeof value === "object") {
    const timestamp = value as { toMillis?: () => number; _seconds?: number; seconds?: number };
    if (typeof timestamp.toMillis === "function") return timestamp.toMillis();
    return Number(timestamp._seconds ?? timestamp.seconds ?? 0) * 1000;
  }
  return 0;
};

const corteTimestamp = (row: Record<string, unknown>): number =>
  timestampMillis(row.generatedAt ?? row.createdAt ?? row.fecha);

const sortCortes = <T extends Record<string, unknown> & { id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => corteTimestamp(b) - corteTimestamp(a) || a.id.localeCompare(b.id));

const rowMatchesFilters = (row: Record<string, unknown>, filters: CorteListFilters): boolean => {
  if (filters.concesionId && row.concesionId !== filters.concesionId) return false;
  if (filters.sucursalId && row.sucursalId !== filters.sucursalId) return false;
  if (filters.cajaId && row.cajaId !== filters.cajaId) return false;
  if (filters.idUser && row.idUser !== filters.idUser) return false;
  if (filters.inventarioId && row.inventarioId !== filters.inventarioId) return false;
  if (filters.sesionCajaId && row.sesionCajaId !== filters.sesionCajaId) return false;
  if (filters.businessDate && (row.businessDate ?? row.fecha) !== filters.businessDate) return false;
  if (filters.jornadaId) {
    const inventoryId = String(row.inventarioId ?? "");
    if (row.jornadaId !== filters.jornadaId && !inventoryId.startsWith(`${filters.jornadaId}__`)) return false;
  }
  return true;
};

export const selectLegacyCorteRows = <T extends Record<string, unknown> & { id: string }>(
  rows: T[],
  filters: CorteListFilters,
): T[] => rows.filter((row) => rowMatchesFilters(row, filters));

const withHistoricalAdapter = (
  row: Record<string, unknown> & { id: string },
): Record<string, unknown> & { id: string; resumen: ReturnType<typeof adaptarCortePersistido> } => ({
  ...row,
  resumen: adaptarCortePersistido(row),
});

const loadCorteRows = async (filters: CorteListFilters = {}) => {
  let query: FirebaseFirestore.Query = col();
  if (filters.concesionId) query = query.where("concesionId", "==", filters.concesionId);
  const snap = await query.get();
  return selectLegacyCorteRows(snap.docs.map(toData), filters);
};

export const paginateCortesRows = <T extends Record<string, unknown> & { id: string }>(
  rows: T[],
  options: { limit?: unknown; cursor?: unknown } = {},
) => {
  const limit = options.limit == null ? 100 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError(400, "limit debe ser un entero entre 1 y 200", true, "INVALID_CORTE_LIMIT");
  }
  let decoded: [number, string] | null = null;
  if (options.cursor != null) {
    try {
      if (typeof options.cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor)) throw new Error();
      const value = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[0]) || value[0] < 0
        || typeof value[1] !== "string" || !value[1] || value[1].length > 512) throw new Error();
      decoded = [value[0], value[1]];
    } catch {
      throw new ApiError(400, "Cursor de historial invalido", true, "INVALID_CORTE_CURSOR");
    }
  }
  const eligible = sortCortes(rows).filter((row) => !decoded
    || corteTimestamp(row) < decoded[0]
    || (corteTimestamp(row) === decoded[0] && row.id.localeCompare(decoded[1]) > 0));
  const rawItems = eligible.slice(0, limit);
  const hasMore = eligible.length > limit;
  const last = rawItems[rawItems.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify([corteTimestamp(last), last.id])).toString("base64url")
    : null;
  return { items: rawItems.map(withHistoricalAdapter), nextCursor, hasMore, limit };
};

/** Raw, unbounded, naturally ordered list kept exclusively for GET /cortes. */
export const listCortesLegacy = async (filters: CorteListFilters = {}) =>
  loadCorteRows(filters);

export const listCortes = async (filters: CorteListFilters = {}) => {
  const rows = await loadCorteRows(filters);
  const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit ?? 100)));
  return sortCortes(rows)
    .slice(0, limit)
    .map(withHistoricalAdapter);
};

export const listCortesPage = async (
  filters: CorteListFilters = {},
  options: { limit?: unknown; cursor?: unknown } = {},
) => paginateCortesRows(await loadCorteRows(filters), options);

export const getCorteById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  }
  return withHistoricalAdapter(toData(doc));
};

export const createCorte = async (
  context: {
    concesionId: string;
    sucursalId?: string | null;
    idUser: string;
    ventaId?: string | null;
  },
  data: {
    fecha: string;
    comentarios?: string;
    estatus: string;
    totalReal: number;
    totalCaja: number;
    totalEfectivo?: number;
    totalTarjeta?: number;
    totalPuntosMonto?: number;
    totalPuntosCanjeados?: number;
    ventasConPuntos?: number;
    cantidadVentas?: number;
    productos?: CorteResumenProducto[];
    promociones2x1?: CorteResumenPromociones2x1;
    combos?: CorteResumenCombos;
    efectivoContado?: number | null;
    diferenciaCaja?: number | null;
    jornadaId?: string | null;
    inventarioId?: string | null;
    sesionCajaId?: string | null;
  },
) => {
  if (data.estatus.trim().toUpperCase() === "CERRADO") {
    throw new ApiError(409, "Use el cierre autoritativo para crear un corte cerrado", true, "CORTE_CLOSE_REQUIRES_AUTHORITATIVE_ENDPOINT");
  }
  const payload = {
    ventaId: context.ventaId ?? null,
    idUser: context.idUser,
    concesionId: context.concesionId,
    sucursalId: context.sucursalId ?? null,
    jornadaId: data.jornadaId ?? null,
    inventarioId: data.inventarioId ?? null,
    sesionCajaId: data.sesionCajaId ?? null,
    fecha: data.fecha,
    comentarios: data.comentarios ?? null,
    estatus: data.estatus,
    totalReal: data.totalReal,
    totalCaja: data.totalCaja,
    totalEfectivo: data.totalEfectivo ?? null,
    totalTarjeta: data.totalTarjeta ?? null,
    totalPuntosMonto: data.totalPuntosMonto ?? null,
    totalPuntosCanjeados: data.totalPuntosCanjeados ?? null,
    ventasConPuntos: data.ventasConPuntos ?? null,
    cantidadVentas: data.cantidadVentas ?? null,
    productos: data.productos ?? null,
    promociones2x1: data.promociones2x1 ?? null,
    combos: data.combos ?? null,
    efectivoContado: data.efectivoContado ?? null,
    diferenciaCaja: data.diferenciaCaja ?? null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const updateCorte = async (
  id: string,
  data: Partial<{
    fecha: string;
    comentarios: string;
    estatus: string;
    totalReal: number;
    totalCaja: number;
    totalEfectivo?: number;
    totalTarjeta?: number;
  }>,
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  return toData(await ref.get());
};

export interface CorteResumenProducto {
  productoId: string;
  nombre: string;
  cantidad: number;
  subtotal: number;
  precioUnitario: number;
}

export interface CorteResumenPromociones2x1 {
  montoTotal: number;
  montoDescuento: number;
  unidadesGratis: number;
  cantidadTransacciones: number;
  items?: unknown[];
}

export interface CorteResumenComboLinea {
  comboId: string;
  nombre: string;
  cantidadVendidos: number;
  montoTotal: number;
}

export interface CorteResumenCombos {
  montoTotal: number;
  cantidadVendidos: number;
  items: CorteResumenComboLinea[];
}

export interface CorteResumen {
  totalVendido: number;
  totalEfectivo: number;
  totalTarjeta: number;
  totalPuntosMonto: number;
  totalPuntosCanjeados: number;
  ventasConPuntos: number;
  cantidadVentas: number;
  productos: CorteResumenProducto[];
  promociones2x1: CorteResumenPromociones2x1;
  combos: CorteResumenCombos;
  efectivoContado: number | null;
  diferenciaCaja: number | null;
  cajaNombre: string | null;
  cajeroNombre: string | null;
  corteCerrado: boolean;
  corteId: string | null;
  jornadaId?: string;
  businessDate?: string;
  calculationVersion?: string;
  ventasBrutas?: number;
  descuentos?: number;
  ventasNetas?: number;
  dineroReal?: number;
  abonados?: unknown;
  cortesias?: unknown;
  merma?: unknown;
  cancelaciones?: number;
  reembolsos?: number;
  comision?: unknown;
  ticketPromedio?: number;
  unidadesVendidas?: number;
  inventario?: unknown;
  incidencias?: unknown[];
  ventasPorHora?: unknown[];
  metodosPago?: unknown;
}

const calculate = (
  ventas: Array<Record<string, unknown>>,
  options: Parameters<typeof calcularComprobantes>[1] = {},
) => calcularComprobantes(ventas, options);

/** Compatibility adapter backed by the central calculator. */
export const aggregateTotalsByMetodoPago = (ventas: Array<Record<string, unknown>>) => {
  const result = calculate(ventas);
  return {
    totalEfectivo: result.finanzas.efectivoNeto,
    totalTarjeta: result.finanzas.tarjetaNeta,
    totalPuntosMonto: result.finanzas.valorPuntosCanjeados,
    totalPuntosCanjeados: result.finanzas.cantidadPuntosCanjeados,
    ventasConPuntos: result.finanzas.cantidadVentasConPuntos,
  };
};

export const aggregateProductosFromVentas = (
  ventas: Array<Record<string, unknown>>,
  productNames: Map<string, string> = new Map(),
): CorteResumenProducto[] => calculate(ventas, { productNames }).productos;

export const aggregatePromociones2x1FromVentas = (
  ventas: Array<Record<string, unknown>>,
): CorteResumenPromociones2x1 => {
  const promotion = calculate(ventas).promociones;
  return {
    montoTotal: promotion.montoTotal,
    montoDescuento: promotion.montoDescuento,
    unidadesGratis: promotion.unidadesGratis,
    cantidadTransacciones: promotion.cantidadTransacciones,
  };
};

export type ReporteTipoVentaTipo = "normal" | "abonado" | "abonado_puntos" | "normal_puntos";

export interface ReporteTipoVentaBucket {
  transacciones: number;
  efectivo: number;
  tarjeta: number;
  puntosMonto: number;
  puntosCanjeados: number;
  valorTotal: number;
  descuentoAbonado: number;
}

export interface ReporteTipoVentaRow extends ReporteTipoVentaBucket {
  tipo: ReporteTipoVentaTipo;
  etiqueta: string;
  descripcion: string;
}

const REPORTE_TIPOS_VENTA_META: Record<ReporteTipoVentaTipo, { etiqueta: string; descripcion: string }> = {
  normal: { etiqueta: "Venta normal", descripcion: "Cliente publico, precio de lista, sin puntos" },
  abonado: { etiqueta: "Venta abonado", descripcion: "Beneficio de temporada, pago en efectivo o tarjeta" },
  abonado_puntos: { etiqueta: "Abonado con puntos", descripcion: "Beneficio abonado con canje total o parcial con puntos" },
  normal_puntos: { etiqueta: "Cliente con puntos", descripcion: "Sin beneficio abonado, pago con puntos" },
};

export const isVentaAbonado = (venta: Record<string, unknown>): boolean =>
  normalizarComprobanteLegacy(venta).abonado === true;

export interface ProductoReporteAgg {
  cantidadRegular: number;
  cantidadAbonado: number;
  ventasRegular: number;
  ventasAbonado: number;
  cortesias: number;
  puntosCanjeados: number;
  ventasTotales: number;
}

export const aggregateProductoReporteFromVentas = (
  ventas: Array<Record<string, unknown>>,
): Map<string, ProductoReporteAgg> => new Map(
  calculate(ventas).productoReporte.map((row) => [row.productoId, {
    cantidadRegular: row.cantidadRegular,
    cantidadAbonado: row.cantidadAbonado,
    ventasRegular: row.ventasRegular,
    ventasAbonado: row.ventasAbonado,
    cortesias: row.cortesias,
    puntosCanjeados: row.puntosCanjeados,
    ventasTotales: row.ventasTotales,
  }]),
);

export interface ReporteProductoTotalesRow extends ProductoReporteAgg {
  dineroReal: number;
}

export const buildReporteProductoTotales = (rows: ProductoReporteAgg[]): ReporteProductoTotalesRow => {
  const totals = rows.reduce<ProductoReporteAgg>((acc, row) => ({
    cantidadRegular: acc.cantidadRegular + row.cantidadRegular,
    cantidadAbonado: acc.cantidadAbonado + row.cantidadAbonado,
    ventasRegular: roundMoney(acc.ventasRegular + row.ventasRegular),
    ventasAbonado: roundMoney(acc.ventasAbonado + row.ventasAbonado),
    cortesias: acc.cortesias + row.cortesias,
    puntosCanjeados: roundMoney(acc.puntosCanjeados + row.puntosCanjeados),
    ventasTotales: roundMoney(acc.ventasTotales + row.ventasTotales),
  }), { cantidadRegular: 0, cantidadAbonado: 0, ventasRegular: 0, ventasAbonado: 0, cortesias: 0, puntosCanjeados: 0, ventasTotales: 0 });
  return { ...totals, dineroReal: roundMoney(totals.ventasTotales - totals.puntosCanjeados) };
};

export const classifyVentaTipo = (venta: Record<string, unknown>): ReporteTipoVentaTipo => {
  const normalized = normalizarComprobanteLegacy(venta);
  const points = normalized.valorPuntos > 0 || normalized.cantidadPuntos > 0;
  if (normalized.abonado && points) return "abonado_puntos";
  if (normalized.abonado) return "abonado";
  return points ? "normal_puntos" : "normal";
};

export const extractMontosVenta = (venta: Record<string, unknown>) => {
  const result = calculate([venta]);
  return {
    efectivo: result.finanzas.efectivoNeto,
    tarjeta: result.finanzas.tarjetaNeta,
    puntosMonto: result.finanzas.valorPuntosCanjeados,
    puntosCanjeados: result.finanzas.cantidadPuntosCanjeados,
    valorTotal: result.finanzas.ventasNetas,
  };
};

export const aggregateTiposVentaFromVentas = (
  ventas: Array<Record<string, unknown>>,
): ReporteTipoVentaRow[] => {
  const tipos: ReporteTipoVentaTipo[] = ["normal", "abonado", "abonado_puntos", "normal_puntos"];
  return tipos.map((tipo) => {
    const result = calculate(ventas.filter((venta) => classifyVentaTipo(venta) === tipo));
    return {
      tipo,
      ...REPORTE_TIPOS_VENTA_META[tipo],
      transacciones: result.finanzas.cantidadTickets,
      efectivo: result.finanzas.efectivoNeto,
      tarjeta: result.finanzas.tarjetaNeta,
      puntosMonto: result.finanzas.valorPuntosCanjeados,
      puntosCanjeados: result.finanzas.cantidadPuntosCanjeados,
      valorTotal: result.finanzas.ventasNetas,
      descuentoAbonado: result.finanzas.descuentosAbonado,
    };
  });
};

export const aggregateCombosFromVentas = (
  ventas: Array<Record<string, unknown>>,
  comboNames: Map<string, string> = new Map(),
): CorteResumenCombos => calculate(ventas, { comboNames }).combos;

const BUSINESS_TIME_ZONE = "America/Mexico_City";

export const currentBusinessDate = (now = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

export interface CorteOperationalContext {
  jornadaId: string;
  businessDate: string;
}

const resolveCorteOperationalContext = async (): Promise<CorteOperationalContext> => {
  const jornada = await resolveJornadaPrimaria();
  return {
    jornadaId: buildJornadaId(jornada.fecha, jornada.jornadaNumero),
    businessDate: jornada.fecha,
  };
};

export const assertCorteContextPreconditions = (
  expected: { expectedJornadaId?: string; expectedBusinessDate?: string },
  authoritative: CorteOperationalContext,
): void => {
  const changed = [
    expected.expectedJornadaId && expected.expectedJornadaId !== authoritative.jornadaId
      ? { field: "expectedJornadaId", message: `La jornada activa ahora es ${authoritative.jornadaId}` }
      : null,
    expected.expectedBusinessDate && expected.expectedBusinessDate !== authoritative.businessDate
      ? { field: "expectedBusinessDate", message: `La fecha operativa ahora es ${authoritative.businessDate}` }
      : null,
  ].filter((item): item is { field: string; message: string } => item != null);
  if (changed.length > 0) {
    throw new ApiError(409, "El contexto operativo cambio; actualiza antes de cerrar", true, "CORTE_CONTEXT_CHANGED", changed);
  }
};

export const computeDiferenciaCaja = (
  efectivoContado: number | null | undefined,
  totalEfectivo: number,
): { efectivoContado: number | null; diferenciaCaja: number | null } => {
  if (efectivoContado == null) return { efectivoContado: null, diferenciaCaja: null };
  const contado = roundMoney(efectivoContado);
  return { efectivoContado: contado, diferenciaCaja: roundMoney(contado - totalEfectivo) };
};

type LoadedCalculation = {
  comprobantes: Array<Record<string, unknown> & { id: string }>;
  calculation: CorteCalculationResult;
};

const loadNamesAndRates = async (filters: OperationalListFilters) => {
  const [products, combos, concessions] = await Promise.all([
    filters.concesionId ? productService.listProducts(filters.concesionId) : productService.listProducts(),
    comboService.listCombos({ ...(filters.concesionId ? { concesionId: filters.concesionId } : {}), includeInactive: true }),
    filters.concesionId
      ? concessionService.getConcessionById(filters.concesionId).then((row) => [row])
      : concessionService.listConcessions(),
  ]);
  return {
    productNames: new Map(products.map((product) => [product.id, String(product.nombre ?? "Producto")])),
    comboNames: new Map(combos.map((combo) => [combo.id, String((combo as { titulo?: string }).titulo ?? "Combo")])),
    concessions: concessions as Array<Record<string, unknown> & { id: string }>,
  };
};

export const loadAuthoritativeCorteCalculation = async (
  filters: OperationalListFilters,
  efectivoContado?: number | null,
): Promise<LoadedCalculation> => {
  const [comprobantesRaw, references] = await Promise.all([
    detalleVentaService.listDetalleVentas(filters),
    loadNamesAndRates(filters),
  ]);
  // One scoped receipt load is enriched once, then every metric reuses the
  // same immutable in-memory set. No dashboard indicator issues its own query.
  const comprobantes = await detalleVentaService.attachDetalleToComprobantes(comprobantesRaw);
  const defaultRate = filters.concesionId
    ? Number(references.concessions.find((row) => row.id === filters.concesionId)?.porcentajeComision ?? 0)
    : 0;
  const base = calcularComprobantes(comprobantes, {
    productNames: references.productNames,
    comboNames: references.comboNames,
    porcentajeComision: defaultRate,
    efectivoContado,
  });

  if (filters.concesionId) return { comprobantes, calculation: base };

  const commissionByConcession = references.concessions.map((concession) => {
    const scoped = comprobantes.filter((row) => row.concesionId === concession.id);
    return calcularComprobantes(scoped, { porcentajeComision: Number(concession.porcentajeComision ?? 0) }).comision;
  });
  return {
    comprobantes,
    calculation: {
      ...base,
      comision: {
        porcentajeAplicado: 0,
        baseComision: base.finanzas.dineroReal,
        importeComision: roundMoney(commissionByConcession.reduce((sum, item) => sum + item.importeComision, 0)),
        reglaRedondeo: "HALF_UP_CENTS" as const,
      },
    },
  };
};

export const selectExactClosedCorte = <T extends Record<string, unknown> & { id: string }>(
  rows: T[],
  filters: OperationalListFilters,
): T | undefined => rows.find((row) =>
  row.estatus === "CERRADO"
  && (["concesionId", "sucursalId", "cajaId", "idUser", "inventarioId"] as const).every(
    (field) => (row[field] ?? null) === (filters[field] ?? null),
  ));

const findCorteCerrado = async (filters: CorteListFilters, businessDate: string) => {
  const rows = await listCortes({ ...filters, businessDate, limit: 200 });
  return selectExactClosedCorte(rows, filters) ?? null;
};

const calculationToResumen = (
  calculation: CorteCalculationResult,
  metadata: {
    cajaNombre?: string | null;
    cajeroNombre?: string | null;
    corteId?: string | null;
    corteCerrado?: boolean;
  } = {},
): CorteResumen => ({
  totalVendido: calculation.finanzas.dineroReal,
  totalEfectivo: calculation.finanzas.efectivoNeto,
  totalTarjeta: calculation.finanzas.tarjetaNeta,
  totalPuntosMonto: calculation.finanzas.valorPuntosCanjeados,
  totalPuntosCanjeados: calculation.finanzas.cantidadPuntosCanjeados,
  ventasConPuntos: calculation.finanzas.cantidadVentasConPuntos,
  cantidadVentas: calculation.finanzas.cantidadTickets,
  productos: calculation.productos,
  promociones2x1: calculation.promociones,
  combos: calculation.combos,
  efectivoContado: calculation.caja.efectivoContado,
  diferenciaCaja: calculation.caja.diferenciaCaja,
  cajaNombre: metadata.cajaNombre ?? null,
  cajeroNombre: metadata.cajeroNombre ?? null,
  corteCerrado: metadata.corteCerrado ?? false,
  corteId: metadata.corteId ?? null,
  calculationVersion: calculation.calculationVersion,
  ventasBrutas: calculation.finanzas.ventasBrutas,
  descuentos: roundMoney(calculation.finanzas.descuentosPromocion + calculation.finanzas.descuentosAbonado),
  ventasNetas: calculation.finanzas.ventasNetas,
  dineroReal: calculation.finanzas.dineroReal,
  abonados: calculation.abonados,
  cortesias: calculation.cortesias,
  merma: calculation.merma,
  cancelaciones: calculation.finanzas.cancelaciones,
  reembolsos: calculation.finanzas.reembolsos,
  comision: calculation.comision,
  ticketPromedio: calculation.finanzas.ticketPromedio,
  unidadesVendidas: calculation.finanzas.cantidadUnidades,
  inventario: calculation.inventario,
  incidencias: calculation.incidencias,
  ventasPorHora: calculation.ventasPorHora,
  metodosPago: calculation.metodosPago,
});

const historicalToResumen = (row: Record<string, unknown> & { id: string }): CorteResumen => {
  const adapted = adaptarCortePersistido(row);
  const finances = adapted.finanzas;
  const caja = adapted.caja;
  return {
    totalVendido: finances.dineroReal,
    totalEfectivo: finances.efectivoNeto,
    totalTarjeta: finances.tarjetaNeta,
    totalPuntosMonto: finances.valorPuntosCanjeados,
    totalPuntosCanjeados: finances.cantidadPuntosCanjeados,
    ventasConPuntos: finances.cantidadVentasConPuntos,
    cantidadVentas: finances.cantidadTickets,
    productos: adapted.productos as CorteResumenProducto[],
    promociones2x1: adapted.promociones as unknown as CorteResumenPromociones2x1,
    combos: adapted.combos as unknown as CorteResumenCombos,
    efectivoContado: caja.efectivoContado,
    diferenciaCaja: caja.diferenciaCaja,
    cajaNombre: typeof row.cajaNombre === "string" ? row.cajaNombre : null,
    cajeroNombre: typeof row.cajeroNombre === "string" ? row.cajeroNombre : null,
    corteCerrado: true,
    corteId: row.id,
    calculationVersion: adapted.calculationVersion,
    ventasBrutas: finances.ventasBrutas,
    descuentos: roundMoney(finances.descuentosPromocion + finances.descuentosAbonado),
    ventasNetas: finances.ventasNetas,
    dineroReal: finances.dineroReal,
    abonados: adapted.abonados,
    cortesias: adapted.cortesias,
    merma: adapted.merma,
    cancelaciones: finances.cancelaciones,
    reembolsos: finances.reembolsos,
    comision: adapted.comision,
    ticketPromedio: finances.ticketPromedio,
    unidadesVendidas: finances.cantidadUnidades,
    inventario: adapted.inventario,
    metodosPago: adapted.metodosPago,
  };
};

export const buildCorteResumen = async (filters: OperationalListFilters): Promise<CorteResumen> => {
  const operationalContext = await resolveCorteOperationalContext();
  const { businessDate } = operationalContext;
  const closed = await findCorteCerrado(filters, businessDate);
  if (closed && closed.totalesSnapshot) return { ...historicalToResumen(closed), ...operationalContext };

  const loaded = await loadAuthoritativeCorteCalculation(filters);
  const first = loaded.comprobantes[0];
  const live = calculationToResumen(loaded.calculation, {
    cajaNombre: typeof first?.cajaNombre === "string" ? first.cajaNombre : null,
    cajeroNombre: typeof first?.cajeroNombre === "string" ? first.cajeroNombre : null,
    corteId: closed?.id ? String(closed.id) : null,
    corteCerrado: Boolean(closed),
  });
  if (!closed) return { ...live, ...operationalContext };

  const legacy = historicalToResumen(closed);
  return {
    ...live,
    ...legacy,
    productos: legacy.productos.length > 0 ? legacy.productos : live.productos,
    promociones2x1: Object.keys(legacy.promociones2x1 ?? {}).length > 0 ? legacy.promociones2x1 : live.promociones2x1,
    combos: legacy.combos?.items ? legacy.combos : live.combos,
    inventario: live.inventario,
    ...operationalContext,
  };
};

export const buildLegacyCloseIdentity = (params: {
  businessDate: string;
  concesionId?: string;
  sucursalId?: string;
  cajaId?: string;
  idUser?: string;
  inventarioId?: string;
  sesionCajaId?: string | null;
}): string => {
  const unit = [params.concesionId, params.sucursalId, params.cajaId, params.idUser, params.businessDate];
  if (unit.some((value) => typeof value !== "string" || !value.trim())) {
    throw new ApiError(400, "Unidad de cierre incompleta", true, "INVALID_CORTE_CLOSE_UNIT");
  }
  // Inventory, jornada, report ranges and cash-session metadata never define
  // another close. One seller owns one caja unit per concession/branch/date.
  const scope = unit.join("|");
  return `corte_${createHash("sha256").update(scope).digest("hex").slice(0, 40)}`;
};

const rowMatchesCloseUnit = (
  row: Record<string, unknown>,
  unit: { businessDate: string; concesionId: string; sucursalId: string; cajaId: string; idUser: string },
): boolean => row.estatus === "CERRADO"
  && row.concesionId === unit.concesionId
  && row.sucursalId === unit.sucursalId
  && row.idUser === unit.idUser
  && (!row.cajaId || row.cajaId === unit.cajaId)
  && (row.businessDate ?? row.fecha) === unit.businessDate;

export const buildDashboardPayload = (
  scope: CorteScopeFilters,
  calculation: CorteCalculationResult,
  recentCuts: Array<Record<string, unknown>>,
  operationalContext?: CorteOperationalContext,
) => ({
  contexto: { ...scope },
  jornadaId: operationalContext?.jornadaId ?? null,
  businessDate: operationalContext?.businessDate ?? null,
  filtrosAplicados: {
    concesionId: scope.concesionId ?? null,
    sucursalId: scope.sucursalId ?? null,
    cajaId: scope.cajaId ?? null,
    idUser: scope.idUser ?? null,
    inventarioId: scope.inventarioId ?? null,
    sesionCajaId: scope.sesionCajaId ?? null,
  },
  ventasNetas: calculation.finanzas.ventasNetas,
  dineroReal: calculation.finanzas.dineroReal,
  efectivo: calculation.finanzas.efectivoNeto,
  tarjeta: calculation.finanzas.tarjetaNeta,
  puntos: calculation.finanzas.valorPuntosCanjeados,
  puntosCanjeados: calculation.finanzas.cantidadPuntosCanjeados,
  tickets: calculation.finanzas.cantidadTickets,
  ticketPromedio: calculation.finanzas.ticketPromedio,
  unidadesVendidas: calculation.finanzas.cantidadUnidades,
  comision: calculation.comision,
  abonados: calculation.abonados,
  promociones: calculation.promociones,
  combos: calculation.combos,
  cortesias: calculation.cortesias,
  merma: calculation.merma,
  cancelaciones: calculation.finanzas.cancelaciones,
  reembolsos: calculation.finanzas.reembolsos,
  inventario: calculation.inventario,
  incidencias: calculation.incidencias,
  ventasPorHora: calculation.ventasPorHora,
  metodosPago: [
    { metodo: "efectivo", monto: calculation.metodosPago.efectivo },
    { metodo: "tarjeta", monto: calculation.metodosPago.tarjeta },
    { metodo: "puntos", monto: calculation.metodosPago.puntos },
  ],
  productosPrincipales: calculation.productos.slice(0, 10),
  cortesRecientes: recentCuts,
});

export const buildCorteDashboard = async (scope: CorteScopeFilters) => {
  const operational: OperationalListFilters = {
    ...(scope.concesionId ? { concesionId: scope.concesionId } : {}),
    ...(scope.sucursalId ? { sucursalId: scope.sucursalId } : {}),
    ...(scope.cajaId ? { cajaId: scope.cajaId } : {}),
    ...(scope.idUser ? { idUser: scope.idUser } : {}),
    ...(scope.inventarioId ? { inventarioId: scope.inventarioId } : {}),
  };
  const [operationalContext, loaded, recentCuts] = await Promise.all([
    resolveCorteOperationalContext(),
    loadAuthoritativeCorteCalculation(operational),
    listCortes({
      ...operational,
      ...(scope.sesionCajaId ? { sesionCajaId: scope.sesionCajaId } : {}),
      limit: 10,
    }),
  ]);
  return buildDashboardPayload(scope, loaded.calculation, recentCuts, operationalContext);
};

const hashIdempotencyKey = (key?: string): string | null =>
  key ? createHash("sha256").update(key).digest("hex") : null;

export interface CorteCloseTransactionPort {
  get(): Promise<{ exists: boolean; idempotencyKeyHash: string | null; conflictingClosed?: boolean }>;
  create(payload: Record<string, unknown>): void;
}

export type CorteCloseTransactionRunner = <T>(
  work: (transaction: CorteCloseTransactionPort) => Promise<T>,
) => Promise<T>;

export const persistCorteIdempotente = async (
  runTransaction: CorteCloseTransactionRunner,
  payload: Record<string, unknown>,
  idempotencyKeyHash: string | null,
): Promise<boolean> => runTransaction(async (transaction) => {
  const existing = await transaction.get();
  if (existing.exists) {
    if (existing.idempotencyKeyHash === idempotencyKeyHash) return true;
    throw new ApiError(409, "Ya existe un corte cerrado para este alcance y fecha", true, "CORTE_ALREADY_CLOSED");
  }
  if (existing.conflictingClosed) {
    throw new ApiError(409, "Ya existe un corte cerrado para este alcance y fecha", true, "CORTE_ALREADY_CLOSED");
  }
  transaction.create(payload);
  return false;
});

export interface CerrarCorteResult extends Record<string, unknown> {
  id: string;
  idempotentReplay?: boolean;
}

export const cerrarCorte = async (
  context: { actorUid: string },
  filters: CorteScopeFilters,
  data: {
    comentarios?: string;
    efectivoContado?: number;
    sesionCajaId?: string;
    expectedJornadaId?: string;
    expectedBusinessDate?: string;
  } = {},
  idempotencyKey?: string,
): Promise<CerrarCorteResult> => {
  if (!filters.concesionId && filters.role !== "SUPERADMIN") {
    throw new ApiError(403, "Alcance de concesion requerido", true, "FORBIDDEN");
  }
  if (idempotencyKey && idempotencyKey.length > 200) {
    throw new ApiError(400, "Idempotency-Key excede 200 caracteres", true, "INVALID_IDEMPOTENCY_KEY");
  }
  const operationalContext = await resolveCorteOperationalContext();
  assertCorteContextPreconditions(data, operationalContext);
  const { businessDate, jornadaId } = operationalContext;
  const sesionCajaId = filters.sesionCajaId ?? null;
  const authoritativeFilters: OperationalListFilters = {
    ...(filters.concesionId ? { concesionId: filters.concesionId } : {}),
    ...(filters.sucursalId ? { sucursalId: filters.sucursalId } : {}),
    ...(filters.cajaId ? { cajaId: filters.cajaId } : {}),
    ...(filters.idUser ? { idUser: filters.idUser } : {}),
    ...(filters.inventarioId ? { inventarioId: filters.inventarioId } : {}),
  };
  const loaded = await loadAuthoritativeCorteCalculation(authoritativeFilters, data.efectivoContado);
  const blocker = loaded.calculation.incidencias.find((incident) => incident.bloqueante);
  if (blocker) {
    throw new ApiError(422, `No se puede cerrar: ${blocker.codigo}`, true, "CORTE_CALCULATION_BLOCKED");
  }

  const generatedAt = FieldValue.serverTimestamp();
  const snapshots = crearSnapshotCorte(loaded.calculation, {
    generatedAt,
    businessDate,
    jornadaId,
    sesionCajaId,
    conteoComprobantes: loaded.comprobantes.length,
  });
  const first = loaded.comprobantes[0];
  const idempotencyKeyHash = hashIdempotencyKey(idempotencyKey);
  const corteId = buildLegacyCloseIdentity({
    businessDate,
    concesionId: filters.concesionId,
    sucursalId: filters.sucursalId,
    cajaId: filters.cajaId,
    idUser: filters.idUser,
    inventarioId: filters.inventarioId,
    sesionCajaId,
  });
  const ref = col().doc(corteId);
  const payload = {
    ventaId: null,
    idUser: filters.idUser ?? null,
    closedBy: context.actorUid,
    concesionId: filters.concesionId ?? null,
    sucursalId: filters.sucursalId ?? null,
    cajaId: filters.cajaId ?? null,
    cajaNombre: typeof first?.cajaNombre === "string" ? first.cajaNombre : null,
    cajeroNombre: typeof first?.cajeroNombre === "string" ? first.cajeroNombre : null,
    inventarioId: filters.inventarioId ?? null,
    fecha: businessDate,
    comentarios: data.comentarios ?? null,
    estatus: "CERRADO",
    totalReal: loaded.calculation.finanzas.dineroReal,
    totalCaja: loaded.calculation.finanzas.efectivoNeto,
    totalEfectivo: loaded.calculation.finanzas.efectivoNeto,
    totalTarjeta: loaded.calculation.finanzas.tarjetaNeta,
    totalPuntosMonto: loaded.calculation.finanzas.valorPuntosCanjeados,
    totalPuntosCanjeados: loaded.calculation.finanzas.cantidadPuntosCanjeados,
    ventasConPuntos: loaded.calculation.finanzas.cantidadVentasConPuntos,
    cantidadVentas: loaded.calculation.finanzas.cantidadTickets,
    productos: loaded.calculation.productos,
    promociones2x1: loaded.calculation.promociones,
    combos: loaded.calculation.combos,
    efectivoContado: loaded.calculation.caja.efectivoContado,
    diferenciaCaja: loaded.calculation.caja.diferenciaCaja,
    idempotencyKeyHash,
    ...snapshots,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };

  const replay = await persistCorteIdempotente(
    async (work) => firestorePos.runTransaction(async (transaction) => work({
      get: async () => {
        const existing = await transaction.get(ref);
        const candidates = await transaction.get(col().where("concesionId", "==", filters.concesionId));
        return {
          exists: existing.exists,
          idempotencyKeyHash: (existing.data()?.idempotencyKeyHash as string | null | undefined) ?? null,
          conflictingClosed: candidates.docs.some((doc) => doc.id !== corteId && rowMatchesCloseUnit(doc.data(), {
            businessDate,
            concesionId: filters.concesionId!,
            sucursalId: filters.sucursalId!,
            cajaId: filters.cajaId!,
            idUser: filters.idUser!,
          })),
        };
      },
      create: (document) => transaction.create(ref, document),
    })),
    payload,
    idempotencyKeyHash,
  );

  const persisted = await ref.get();
  if (!persisted.exists) {
    throw new ApiError(503, "El corte no pudo confirmarse", true, "CORTE_PERSISTENCE_FAILED");
  }
  return { ...toData(persisted), ...(replay ? { idempotentReplay: true } : {}) };
};
