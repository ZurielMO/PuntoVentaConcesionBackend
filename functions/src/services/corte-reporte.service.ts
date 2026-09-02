import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import {
  aggregateProductoReporteFromVentas,
  aggregateTotalsByMetodoPago,
  buildReporteProductoTotales,
  listCortes,
  type ProductoReporteAgg,
  type ReporteProductoTotalesRow,
} from "./corte.service";
import * as concessionService from "./concession.service";
import * as detalleVentaService from "./detalle-venta.service";
import * as productService from "./product.service";
import { resolveJornadaParaReporte } from "./jornada.service";
import {
  normalizeRama,
  ramaFromInventario,
  type JornadaRama,
} from "./asignacion-caja.service";
import { matchesJornadaListFilter } from "./detalle-venta.service";
import type { ConcessionTipo } from "../models";
import { isVentaPalcos } from "../utils/venta-palcos.util";

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
  /** Parte de ventasTotales originada en VIP / VIP Stripe (palcos). */
  ventaPalcos: number;
  /** Precio de lista actual del catálogo */
  precioActual: number;
  /** Descuento unitario abonado (precio lista − precio abonado efectivo) */
  descuentoAbonado: number;
}

export interface ReporteIngresos {
  ventaNeta: number;
  totalEfectivo: number;
  totalTarjeta: number;
  totalPuntosMonto: number;
  totalPuntosCanjeados: number;
  ventasConPuntos: number;
  cantidadVentas: number;
}

export interface ReporteConcesionRow {
  concesionId: string;
  nombre: string;
  porcentajeComision: number;
  /** Incluye POS + palcos (efectivo + tarjeta). */
  totalVenta: number;
  /** Parte de totalVenta originada en VIP / VIP Stripe (palcos). */
  ventaPalcos: number;
  cantidadVentasPalcos: number;
  comision: number;
  gananciaConcesion: number;
}

export interface ReporteConcesionInfo {
  id: string;
  nombre: string;
  tipo: ConcessionTipo;
}

export interface ReporteCortes {
  jornada: {
    fecha: string;
    numero: number;
    jornadaId: string;
    rama?: JornadaRama;
  };
  /** Concesión del reporte; null en el consolidado de todas las concesiones. */
  concesion: ReporteConcesionInfo | null;
  productos: ReporteProductoRow[] | null;
  productoTotales: ReporteProductoTotalesRow | null;
  resumen: ReporteConcesionRow[];
  ingresos: ReporteIngresos | null;
}

export interface ReporteCortesFilters {
  concesionId?: string;
  sucursalId?: string;
  jornadaId?: string;
  fecha?: string;
  jornadaNumero?: number;
}

type StockAgg = {
  inventarioInicial: number;
  inventarioFinal: number;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const loadInventariosJornada = async (
  concesionId: string,
  fecha: string,
  jornadaNumero: number,
  rama: JornadaRama = "varonil",
  sucursalId?: string,
) => {
  let query: FirebaseFirestore.Query = inventariosCol()
    .where("concesion_id", "==", concesionId)
    .where("jornada_fecha", "==", fecha)
    .where("jornada_numero", "==", jornadaNumero);

  const snap = await query.get();
  let inventarios = snap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Record<string, unknown>),
  }));

  inventarios = inventarios.filter(
    (inv) => ramaFromInventario(inv, inv.id) === normalizeRama(rama),
  );

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
  _inventarioIds: Set<string>,
) => ventas.filter((v) => matchesJornadaListFilter(v, jornadaId));

const emptyProductoReporteAgg = (): ProductoReporteAgg => ({
  cantidadRegular: 0,
  cantidadAbonado: 0,
  ventasRegular: 0,
  ventasAbonado: 0,
  cortesias: 0,
  puntosCanjeados: 0,
  ventasTotales: 0,
  ventaPalcos: 0,
});

const isCorteCerrado = (corte: Record<string, unknown>) =>
  String(corte.estatus ?? "").toUpperCase() === "CERRADO";

const hasCorteProductosOTotal = (corte: Record<string, unknown>) => {
  const total =
    corte.totalEfectivo != null
      ? Number(corte.totalEfectivo)
      : Number(corte.totalReal ?? 0);
  const productos = Array.isArray(corte.productos) ? corte.productos : [];
  return total > 0 || productos.length > 0;
};

/**
 * Cortes a fusionar en el reporte:
 * - tipoCorte === "CONTEO" (camino normal), o
 * - sin ventas POS y corte cerrado con totales/productos (fallback si falta tipoCorte).
 * No usa cortes POS cuando ya hay tickets, para evitar doble conteo.
 */
const selectCortesConteoParaReporte = (
  cortes: Array<Record<string, unknown>>,
  hasPosVentas: boolean,
): Array<Record<string, unknown>> =>
  cortes.filter((c) => {
    if (!isCorteCerrado(c)) return false;
    if (c.tipoCorte === "CONTEO") return true;
    if (
      !hasPosVentas &&
      (c.tipoCorte == null || c.tipoCorte === "") &&
      hasCorteProductosOTotal(c)
    ) {
      return true;
    }
    return false;
  });

const loadCortesJornada = async (
  concesionId: string,
  jornadaId: string,
  sucursalId?: string,
) => {
  const cortes = await listCortes({ concesionId, sucursalId, jornadaId });
  return cortes as Array<Record<string, unknown>>;
};

const totalEfectivoFromCortesConteo = (
  cortes: Array<Record<string, unknown>>,
) =>
  roundMoney(
    cortes.reduce((sum, c) => {
      const efectivo =
        c.totalEfectivo != null
          ? Number(c.totalEfectivo)
          : Number(c.totalReal ?? 0);
      return sum + efectivo;
    }, 0),
  );

/** Ventas derivadas de cortes por conteo (sin tickets POS). */
const aggregateProductoReporteFromCortesConteo = (
  cortes: Array<Record<string, unknown>>,
): Map<string, ProductoReporteAgg> => {
  const byProduct = new Map<string, ProductoReporteAgg>();

  for (const corte of cortes) {
    const productos = Array.isArray(corte.productos)
      ? (corte.productos as Array<Record<string, unknown>>)
      : [];

    for (const linea of productos) {
      const productoId = String(linea.productoId ?? "");
      if (!productoId) continue;

      const cantidad = Number(linea.cantidad ?? 0);
      const subtotal = Number(linea.subtotal ?? 0);
      const prev = byProduct.get(productoId) ?? emptyProductoReporteAgg();

      prev.cantidadRegular += cantidad;
      prev.ventasRegular = roundMoney(prev.ventasRegular + subtotal);
      prev.ventasTotales = roundMoney(prev.ventasTotales + subtotal);
      byProduct.set(productoId, prev);
    }
  }

  return byProduct;
};

const mergeProductoReporteMaps = (
  base: Map<string, ProductoReporteAgg>,
  extra: Map<string, ProductoReporteAgg>,
): Map<string, ProductoReporteAgg> => {
  const merged = new Map(base);

  for (const [productoId, row] of extra) {
    const prev = merged.get(productoId);
    if (!prev) {
      merged.set(productoId, { ...row });
      continue;
    }
    merged.set(productoId, {
      cantidadRegular: prev.cantidadRegular + row.cantidadRegular,
      cantidadAbonado: prev.cantidadAbonado + row.cantidadAbonado,
      ventasRegular: roundMoney(prev.ventasRegular + row.ventasRegular),
      ventasAbonado: roundMoney(prev.ventasAbonado + row.ventasAbonado),
      cortesias: prev.cortesias + row.cortesias,
      puntosCanjeados: roundMoney(prev.puntosCanjeados + row.puntosCanjeados),
      ventasTotales: roundMoney(prev.ventasTotales + row.ventasTotales),
      ventaPalcos: roundMoney(prev.ventaPalcos + row.ventaPalcos),
    });
  }

  return merged;
};

const applyConteoToResumen = (
  resumen: ReporteConcesionRow,
  totalConteo: number,
  porcentajeComision: number,
): ReporteConcesionRow => {
  if (totalConteo <= 0) return resumen;
  const totalVenta = roundMoney(resumen.totalVenta + totalConteo);
  const comision = roundMoney((totalVenta * porcentajeComision) / 100);
  return {
    ...resumen,
    totalVenta,
    comision,
    gananciaConcesion: roundMoney(totalVenta - comision),
  };
};

const applyConteoToIngresos = (
  ingresos: ReporteIngresos,
  totalConteo: number,
  cantidadCortes: number,
): ReporteIngresos => {
  if (totalConteo <= 0 && cantidadCortes <= 0) return ingresos;
  const totalEfectivo = roundMoney(ingresos.totalEfectivo + totalConteo);
  return {
    ...ingresos,
    totalEfectivo,
    ventaNeta: roundMoney(totalEfectivo + ingresos.totalTarjeta),
    cantidadVentas: ingresos.cantidadVentas + cantidadCortes,
  };
};

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
      ventaPalcos: number;
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
    const precioActual = Number(catalogProduct?.precio ?? 0);
    const cantidadAbonado = ventas?.cantidadAbonado ?? 0;
    const ventasAbonado = ventas?.ventasAbonado ?? 0;
    const precioAbonadoUnitario =
      cantidadAbonado > 0 ? ventasAbonado / cantidadAbonado : 0;
    const descuentoAbonado =
      precioActual > 0 && precioAbonadoUnitario > 0
        ? roundMoney(Math.max(0, precioActual - precioAbonadoUnitario))
        : 0;

    rows.push({
      productoId,
      nombre: String(catalogProduct?.nombre ?? "Producto"),
      inventarioInicial: stock?.inventarioInicial ?? 0,
      inventarioFinal: stock?.inventarioFinal ?? 0,
      cantidadRegular: ventas?.cantidadRegular ?? 0,
      cantidadAbonado,
      ventasRegular: ventas?.ventasRegular ?? 0,
      ventasAbonado,
      cortesias: ventas?.cortesias ?? 0,
      puntosCanjeados: ventas?.puntosCanjeados ?? 0,
      ventasTotales: ventas?.ventasTotales ?? 0,
      ventaPalcos: ventas?.ventaPalcos ?? 0,
      precioActual,
      descuentoAbonado,
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
  ventas: Array<Record<string, unknown>>,
): ReporteConcesionRow => {
  const { totalEfectivo, totalTarjeta } = aggregateTotalsByMetodoPago(ventas);
  const totalVenta = roundMoney(totalEfectivo + totalTarjeta);

  const ventasPalcos = ventas.filter(isVentaPalcos);
  const palcosMontos = aggregateTotalsByMetodoPago(ventasPalcos);
  const ventaPalcos = roundMoney(
    palcosMontos.totalEfectivo + palcosMontos.totalTarjeta,
  );

  const porcentajeComision = Number(concesion.porcentajeComision ?? 0);
  const comision = roundMoney((totalVenta * porcentajeComision) / 100);
  const gananciaConcesion = roundMoney(totalVenta - comision);

  return {
    concesionId: concesion.id,
    nombre: String(concesion.nombre ?? concesion.id),
    porcentajeComision,
    totalVenta,
    ventaPalcos,
    cantidadVentasPalcos: ventasPalcos.length,
    comision,
    gananciaConcesion,
  };
};

const buildIngresosFromVentas = (
  ventas: Array<Record<string, unknown>>,
): ReporteIngresos => {
  const {
    totalEfectivo,
    totalTarjeta,
    totalPuntosMonto,
    totalPuntosCanjeados,
    ventasConPuntos,
  } = aggregateTotalsByMetodoPago(ventas);

  return {
    ventaNeta: roundMoney(totalEfectivo + totalTarjeta),
    totalEfectivo,
    totalTarjeta,
    totalPuntosMonto,
    totalPuntosCanjeados,
    ventasConPuntos,
    cantidadVentas: ventas.length,
  };
};

const buildReporteForConcesion = async (
  concesion: Record<string, unknown> & { id: string },
  jornada: {
    fecha: string;
    numero: number;
    jornadaId: string;
    rama: JornadaRama;
  },
  sucursalId?: string,
  includeDetalle = false,
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
    jornada.rama,
    sucursalId,
  );
  const inventarioIds = new Set(inventarios.map((inv) => inv.id));

  const ventasRaw = await detalleVentaService.listDetalleVentas({
    concesionId: concesion.id,
    sucursalId,
    jornadaId: jornada.jornadaId,
  });
  const ventasFiltradas = filterVentasJornada(
    ventasRaw,
    jornada.jornadaId,
    inventarioIds,
  );
  const ventas = await detalleVentaService.attachDetalleToComprobantes(
    ventasFiltradas as Array<Record<string, unknown> & { id: string }>,
  );

  const cortesJornada = await loadCortesJornada(
    concesion.id,
    jornada.jornadaId,
    sucursalId,
  );
  const cortesConteo = selectCortesConteoParaReporte(
    cortesJornada,
    ventas.length > 0,
  );
  const totalConteo = totalEfectivoFromCortesConteo(cortesConteo);
  const porcentajeComision = Number(concesion.porcentajeComision ?? 0);

  const resumen = applyConteoToResumen(
    buildResumenConcesion(concesion, ventas),
    totalConteo,
    porcentajeComision,
  );
  const ingresos = applyConteoToIngresos(
    buildIngresosFromVentas(ventas),
    totalConteo,
    cortesConteo.length,
  );

  if (!includeDetalle) {
    return {
      productos: null,
      productoTotales: null,
      resumen,
      ingresos,
    };
  }

  const stockByProduct = await aggregateStockByProduct(inventarios);
  const ventasByProduct = mergeProductoReporteMaps(
    aggregateProductoReporteFromVentas(ventas),
    aggregateProductoReporteFromCortesConteo(cortesConteo),
  );
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
      ventaPalcos: p.ventaPalcos,
    })),
  );

  return {
    productos,
    productoTotales,
    resumen,
    ingresos,
  };
};

export const buildReporteCortes = async (
  filters: ReporteCortesFilters,
): Promise<ReporteCortes> => {
  if (!filters.jornadaId && !(filters.fecha && filters.jornadaNumero != null)) {
    throw new ApiError(
      400,
      "Debes indicar jornadaId para el reporte de cortes",
      true,
      "MISSING_JORNADA",
    );
  }

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
    rama: resolved.rama,
  };

  if (filters.concesionId) {
    const concesion = await concessionService.getConcessionById(filters.concesionId);
    const { productos, productoTotales, resumen, ingresos } =
      await buildReporteForConcesion(
        concesion as Record<string, unknown> & { id: string },
        jornada,
        filters.sucursalId,
        true,
      );
    return {
      jornada,
      concesion: {
        id: concesion.id,
        nombre: String(concesion.nombre ?? concesion.id),
        tipo: concesion.tipo === "CERVECERIA" ? "CERVECERIA" : "GENERAL",
      },
      productos,
      productoTotales,
      resumen: [resumen],
      ingresos,
    };
  }

  const concesiones = await concessionService.listConcessions();
  const resumenRows: ReporteConcesionRow[] = [];
  const ingresosAgg: ReporteIngresos = {
    ventaNeta: 0,
    totalEfectivo: 0,
    totalTarjeta: 0,
    totalPuntosMonto: 0,
    totalPuntosCanjeados: 0,
    ventasConPuntos: 0,
    cantidadVentas: 0,
  };

  for (const concesion of concesiones) {
    const { resumen, ingresos } = await buildReporteForConcesion(
      concesion as Record<string, unknown> & { id: string },
      jornada,
      filters.sucursalId,
      false,
    );
    resumenRows.push(resumen);
    if (ingresos) {
      ingresosAgg.totalEfectivo = roundMoney(
        ingresosAgg.totalEfectivo + ingresos.totalEfectivo,
      );
      ingresosAgg.totalTarjeta = roundMoney(
        ingresosAgg.totalTarjeta + ingresos.totalTarjeta,
      );
      ingresosAgg.totalPuntosMonto = roundMoney(
        ingresosAgg.totalPuntosMonto + ingresos.totalPuntosMonto,
      );
      ingresosAgg.totalPuntosCanjeados = roundMoney(
        ingresosAgg.totalPuntosCanjeados + ingresos.totalPuntosCanjeados,
      );
      ingresosAgg.ventasConPuntos += ingresos.ventasConPuntos;
      ingresosAgg.cantidadVentas += ingresos.cantidadVentas;
    }
  }

  ingresosAgg.ventaNeta = roundMoney(
    ingresosAgg.totalEfectivo + ingresosAgg.totalTarjeta,
  );

  return {
    jornada,
    concesion: null,
    productos: null,
    productoTotales: null,
    resumen: resumenRows.sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
    ingresos: ingresosAgg,
  };
};
