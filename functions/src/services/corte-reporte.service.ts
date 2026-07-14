import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import {
  aggregateProductoReporteFromVentas,
  buildReporteProductoTotales,
  listCortes,
  type ReporteProductoTotalesRow,
} from "./corte.service";
import {
  adaptarCortePersistido,
  calcularComprobantes,
  type CorteCalculationResult,
} from "../domain/cortes/corte-calculator";
import * as concessionService from "./concession.service";
import * as detalleVentaService from "./detalle-venta.service";
import * as productService from "./product.service";
import { resolveJornadaParaReporte } from "./jornada.service";

const inventariosCol = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);
const productosCol = (inventarioId: string) =>
  inventariosCol().doc(inventarioId).collection(SUBCOLLECTIONS.PRODUCTOS);

export interface ReporteProductoRow {
  productoId: string;
  nombre: string;
  inventarioInicial: number;
  inventarioFinal: number;
  cantidadRegular: number;
  cantidadAbonado: number;
  ventasRegular: number;
  ventasAbonado: number;
  cortesias: number;
  puntosCanjeados: number;
  ventasTotales: number;
}

export interface ReporteIngresos {
  ventaNeta: number;
  totalEfectivo: number;
  totalTarjeta: number;
  totalPuntosMonto: number;
  totalPuntosCanjeados: number;
  ventasConPuntos: number;
  cantidadVentas: number;
  ventasBrutas?: number;
  descuentos?: number;
  ventasNetas?: number;
  dineroReal?: number;
  abonados?: unknown;
  cortesias?: unknown;
  promociones?: unknown;
  combos?: unknown;
  merma?: unknown;
  cancelaciones?: number;
  reembolsos?: number;
  comision?: unknown;
  ticketPromedio?: number;
  unidadesVendidas?: number;
}

export interface ReporteConcesionRow {
  concesionId: string;
  nombre: string;
  porcentajeComision: number;
  totalVenta: number;
  comision: number;
  gananciaConcesion: number;
  /** Cantidad de puntos canjeados. No representa dinero real. */
  totalPuntosCanjeados: number;
  /** Valor en MXN cubierto con puntos. Se presenta fuera del dinero real. */
  valorPuntosCanjeados: number;
  /** Descuentos de promoción y abonado; no incluye otros beneficios. */
  descuentos: number;
}

export interface ReporteCortes {
  jornada: { fecha: string; numero: number; jornadaId: string };
  productos: ReporteProductoRow[] | null;
  productoTotales: ReporteProductoTotalesRow | null;
  resumen: ReporteConcesionRow[];
  ingresos: ReporteIngresos | null;
}

export interface ReporteCortesFilters {
  concesionId?: string;
  sucursalId?: string;
  cajaId?: string;
  idUser?: string;
  inventarioId?: string;
  jornadaId?: string;
  fecha?: string;
  jornadaNumero?: number;
}

export const selectScopedSnapshot = <T extends Record<string, unknown> & { id: string }>(
  cuts: T[],
  filters: Pick<ReporteCortesFilters, "cajaId" | "idUser" | "inventarioId">,
): T | undefined => cuts.find((row) =>
  row.estatus === "CERRADO"
  && Boolean(row.totalesSnapshot)
  && (["cajaId", "idUser", "inventarioId"] as const).every(
    (field) => (row[field] ?? null) === (filters[field] ?? null),
  ));

type StockAgg = {
  inventarioInicial: number;
  inventarioFinal: number;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const loadInventariosJornada = async (
  concesionId: string,
  fecha: string,
  jornadaNumero: number,
  sucursalId?: string,
) => {
  let query: FirebaseFirestore.Query = inventariosCol()
    .where("concesion_id", "==", concesionId)
    .where("jornada_fecha", "==", fecha)
    .where("jornada_numero", "==", jornadaNumero);

  const snap = await query.get();
  let inventarios = snap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  if (sucursalId) {
    inventarios = inventarios.filter(
      (inv) => (inv as { sucursal_id?: string }).sucursal_id === sucursalId,
    );
  }

  return inventarios;
};

const aggregateStockByProduct = async (
  inventarios: Array<{ id: string }>,
): Promise<Map<string, StockAgg>> => {
  const byProduct = new Map<string, StockAgg>();

  for (const inv of inventarios) {
    const prodSnap = await productosCol(inv.id).get();
    for (const prodDoc of prodSnap.docs) {
      const data = prodDoc.data();
      const productoId = String(data.producto_id ?? prodDoc.id);
      const inicial = Number(data.cantidad_inicial ?? 0);
      const final = Number(data.cantidad_final ?? inicial);

      const prev = byProduct.get(productoId);
      byProduct.set(productoId, {
        inventarioInicial: (prev?.inventarioInicial ?? 0) + inicial,
        inventarioFinal: (prev?.inventarioFinal ?? 0) + final,
      });
    }
  }

  return byProduct;
};

const filterVentasJornada = (
  ventas: Array<Record<string, unknown>>,
  jornadaId: string,
  inventarioIds: Set<string>,
) =>
  ventas.filter((v) => {
    if (v.jornadaId === jornadaId) return true;
    const invId = v.inventarioId as string | undefined;
    return invId ? inventarioIds.has(invId) : false;
  });

const buildProductosReporte = async (
  concesionId: string,
  stockByProduct: Map<string, StockAgg>,
  ventasByProduct: Map<
    string,
    {
      cantidadRegular: number;
      cantidadAbonado: number;
      ventasRegular: number;
      ventasAbonado: number;
      cortesias: number;
      puntosCanjeados: number;
      ventasTotales: number;
    }
  >,
): Promise<ReporteProductoRow[]> => {
  const catalog = await productService.listProducts(concesionId);
  const productIds = new Set<string>([
    ...catalog.map((p) => p.id),
    ...stockByProduct.keys(),
    ...ventasByProduct.keys(),
  ]);

  const rows: ReporteProductoRow[] = [];

  for (const productoId of productIds) {
    const catalogProduct = catalog.find((p) => p.id === productoId);
    const stock = stockByProduct.get(productoId);
    const ventas = ventasByProduct.get(productoId);

    rows.push({
      productoId,
      nombre: String(catalogProduct?.nombre ?? "Producto"),
      inventarioInicial: stock?.inventarioInicial ?? 0,
      inventarioFinal: stock?.inventarioFinal ?? 0,
      cantidadRegular: ventas?.cantidadRegular ?? 0,
      cantidadAbonado: ventas?.cantidadAbonado ?? 0,
      ventasRegular: ventas?.ventasRegular ?? 0,
      ventasAbonado: ventas?.ventasAbonado ?? 0,
      cortesias: ventas?.cortesias ?? 0,
      puntosCanjeados: ventas?.puntosCanjeados ?? 0,
      ventasTotales: ventas?.ventasTotales ?? 0,
    });
  }

  return rows
    .filter(
      (row) =>
        row.inventarioInicial > 0 ||
        row.inventarioFinal > 0 ||
        row.ventasTotales > 0 ||
        row.cortesias > 0,
    )
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
};

const buildResumenConcesion = (
  concesion: Record<string, unknown> & { id: string },
  calculation: CorteCalculationResult,
): ReporteConcesionRow => {
  const totalVenta = calculation.finanzas.dineroReal;
  const porcentajeComision = Number(concesion.porcentajeComision ?? 0);
  const comision = calculation.comision.importeComision;
  const gananciaConcesion = roundMoney(totalVenta - comision);

  return {
    concesionId: concesion.id,
    nombre: String(concesion.nombre ?? concesion.id),
    porcentajeComision,
    totalVenta,
    comision,
    gananciaConcesion,
    totalPuntosCanjeados: calculation.finanzas.cantidadPuntosCanjeados,
    valorPuntosCanjeados: calculation.finanzas.valorPuntosCanjeados,
    descuentos: roundMoney(
      calculation.finanzas.descuentosPromocion + calculation.finanzas.descuentosAbonado,
    ),
  };
};

const buildIngresosFromVentas = (
  calculation: CorteCalculationResult,
): ReporteIngresos => {
  return {
    ventaNeta: calculation.finanzas.ventasNetas,
    totalEfectivo: calculation.finanzas.efectivoNeto,
    totalTarjeta: calculation.finanzas.tarjetaNeta,
    totalPuntosMonto: calculation.finanzas.valorPuntosCanjeados,
    totalPuntosCanjeados: calculation.finanzas.cantidadPuntosCanjeados,
    ventasConPuntos: calculation.finanzas.cantidadVentasConPuntos,
    cantidadVentas: calculation.finanzas.cantidadTickets,
    ventasBrutas: calculation.finanzas.ventasBrutas,
    descuentos: roundMoney(
      calculation.finanzas.descuentosPromocion + calculation.finanzas.descuentosAbonado,
    ),
    ventasNetas: calculation.finanzas.ventasNetas,
    dineroReal: calculation.finanzas.dineroReal,
    abonados: calculation.abonados,
    cortesias: calculation.cortesias,
    promociones: calculation.promociones,
    combos: calculation.combos,
    merma: calculation.merma,
    cancelaciones: calculation.finanzas.cancelaciones,
    reembolsos: calculation.finanzas.reembolsos,
    comision: calculation.comision,
    ticketPromedio: calculation.finanzas.ticketPromedio,
    unidadesVendidas: calculation.finanzas.cantidadUnidades,
  };
};

const buildReporteForConcesion = async (
  concesion: Record<string, unknown> & { id: string },
  jornada: { fecha: string; numero: number; jornadaId: string },
  sucursalId?: string,
  includeDetalle = false,
  operationalFilters: Pick<ReporteCortesFilters, "cajaId" | "idUser" | "inventarioId"> = {},
): Promise<{
  productos: ReporteProductoRow[] | null;
  productoTotales: ReporteProductoTotalesRow | null;
  resumen: ReporteConcesionRow;
  ingresos: ReporteIngresos | null;
}> => {
  const inventarios = await loadInventariosJornada(
    concesion.id,
    jornada.fecha,
    jornada.numero,
    sucursalId,
  );
  const inventarioIds = new Set(inventarios.map((inv) => inv.id));

  const ventasRaw = await detalleVentaService.listDetalleVentas({
    concesionId: concesion.id,
    sucursalId,
    cajaId: operationalFilters.cajaId,
    idUser: operationalFilters.idUser,
    inventarioId: operationalFilters.inventarioId,
  });
  const ventasFiltradas = filterVentasJornada(
    ventasRaw,
    jornada.jornadaId,
    inventarioIds,
  );
  const ventas = await detalleVentaService.attachDetalleToComprobantes(
    ventasFiltradas as Array<Record<string, unknown> & { id: string }>,
  );

  const liveCalculation = calcularComprobantes(ventas, {
    porcentajeComision: Number(concesion.porcentajeComision ?? 0),
  });
  const cuts = await listCortes({
    concesionId: concesion.id,
    sucursalId,
    cajaId: operationalFilters.cajaId,
    idUser: operationalFilters.idUser,
    inventarioId: operationalFilters.inventarioId,
    jornadaId: jornada.jornadaId,
    businessDate: jornada.fecha,
    limit: 200,
  });
  const snapshottedCut = selectScopedSnapshot(cuts, operationalFilters);
  const persisted = snapshottedCut ? adaptarCortePersistido(snapshottedCut) : null;
  const financialCalculation: CorteCalculationResult = persisted
    ? {
        ...liveCalculation,
        finanzas: persisted.finanzas,
        metodosPago: persisted.metodosPago,
        comision: persisted.comision as CorteCalculationResult["comision"],
        abonados: persisted.abonados as CorteCalculationResult["abonados"],
        cortesias: persisted.cortesias as CorteCalculationResult["cortesias"],
        promociones: persisted.promociones as CorteCalculationResult["promociones"],
        combos: persisted.combos as CorteCalculationResult["combos"],
        merma: persisted.merma as CorteCalculationResult["merma"],
        inventario: persisted.inventario as CorteCalculationResult["inventario"],
      }
    : liveCalculation;
  const resumen = buildResumenConcesion(concesion, financialCalculation);

  if (!includeDetalle) {
    return {
      productos: null,
      productoTotales: null,
      resumen,
      ingresos: null,
    };
  }

  const stockByProduct = await aggregateStockByProduct(inventarios);
  const ventasByProduct = aggregateProductoReporteFromVentas(ventas);
  const productos = await buildProductosReporte(
    concesion.id,
    stockByProduct,
    ventasByProduct,
  );
  const productoTotales = buildReporteProductoTotales(
    productos.map((p) => ({
      cantidadRegular: p.cantidadRegular,
      cantidadAbonado: p.cantidadAbonado,
      ventasRegular: p.ventasRegular,
      ventasAbonado: p.ventasAbonado,
      cortesias: p.cortesias,
      puntosCanjeados: p.puntosCanjeados,
      ventasTotales: p.ventasTotales,
    })),
  );

  return {
    productos,
    productoTotales,
    resumen,
    ingresos: buildIngresosFromVentas(financialCalculation),
  };
};

export const buildReporteCortes = async (
  filters: ReporteCortesFilters,
): Promise<ReporteCortes> => {
  const resolved = await resolveJornadaParaReporte({
    jornadaId: filters.jornadaId,
    fecha: filters.fecha,
    jornadaNumero: filters.jornadaNumero,
    concesionId: filters.concesionId,
    sucursalId: filters.sucursalId,
  });

  const jornada = {
    fecha: resolved.fecha,
    numero: resolved.numero,
    jornadaId: resolved.jornadaId,
  };

  if (filters.concesionId) {
    const concesion = await concessionService.getConcessionById(filters.concesionId);
    const { productos, productoTotales, resumen, ingresos } =
      await buildReporteForConcesion(
        concesion as Record<string, unknown> & { id: string },
        jornada,
        filters.sucursalId,
        true,
        filters,
      );
    return {
      jornada,
      productos,
      productoTotales,
      resumen: [resumen],
      ingresos,
    };
  }

  const concesiones = await concessionService.listConcessions();
  const resumenRows: ReporteConcesionRow[] = [];

  for (const concesion of concesiones) {
    const { resumen } = await buildReporteForConcesion(
      concesion as Record<string, unknown> & { id: string },
      jornada,
      filters.sucursalId,
      false,
      filters,
    );
    resumenRows.push(resumen);
  }

  return {
    jornada,
    productos: null,
    productoTotales: null,
    resumen: resumenRows.sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
    ingresos: null,
  };
};
