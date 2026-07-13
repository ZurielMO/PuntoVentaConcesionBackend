import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import {
  aggregateProductoReporteFromVentas,
  aggregateTotalsByMetodoPago,
  buildReporteProductoTotales,
  type ReporteProductoTotalesRow,
} from "./corte.service";
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
}

export interface ReporteConcesionRow {
  concesionId: string;
  nombre: string;
  porcentajeComision: number;
  totalVenta: number;
  comision: number;
  gananciaConcesion: number;
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
  ventas: Array<Record<string, unknown>>,
): ReporteConcesionRow => {
  const { totalEfectivo, totalTarjeta } = aggregateTotalsByMetodoPago(ventas);
  const totalVenta = roundMoney(totalEfectivo + totalTarjeta);
  const porcentajeComision = Number(concesion.porcentajeComision ?? 0);
  const comision = roundMoney((totalVenta * porcentajeComision) / 100);
  const gananciaConcesion = roundMoney(totalVenta - comision);

  return {
    concesionId: concesion.id,
    nombre: String(concesion.nombre ?? concesion.id),
    porcentajeComision,
    totalVenta,
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
  jornada: { fecha: string; numero: number; jornadaId: string },
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
    sucursalId,
  );
  const inventarioIds = new Set(inventarios.map((inv) => inv.id));

  const ventasRaw = await detalleVentaService.listDetalleVentas({
    concesionId: concesion.id,
    sucursalId,
  });
  const ventasFiltradas = filterVentasJornada(
    ventasRaw,
    jornada.jornadaId,
    inventarioIds,
  );
  const ventas = await detalleVentaService.attachDetalleToComprobantes(
    ventasFiltradas as Array<Record<string, unknown> & { id: string }>,
  );

  const resumen = buildResumenConcesion(concesion, ventas);

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
    ingresos: buildIngresosFromVentas(ventas),
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
