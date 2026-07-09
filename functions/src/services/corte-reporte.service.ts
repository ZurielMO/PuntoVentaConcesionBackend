import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { buildJornadaId } from "./asignacion-caja.service";
import { aggregateTotalsByMetodoPago } from "./corte.service";
import * as concessionService from "./concession.service";
import * as detalleVentaService from "./detalle-venta.service";
import * as productService from "./product.service";
import { resolveJornadaPrimaria } from "./jornada.service";
import { normalizeFecha } from "./inventario.service";

const inventariosCol = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);
const productosCol = (inventarioId: string) =>
  inventariosCol().doc(inventarioId).collection(SUBCOLLECTIONS.PRODUCTOS);

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export interface ReporteProductoRow {
  productoId: string;
  nombre: string;
  inventarioInicial: number;
  precioUnitario: number;
  inventarioFinal: number;
  cortesias: number;
  totalVendido: number;
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
  resumen: ReporteConcesionRow[];
}

export interface ReporteCortesFilters {
  concesionId?: string;
  sucursalId?: string;
  fecha?: string;
  jornadaNumero?: number;
}

type StockAgg = {
  inventarioInicial: number;
  inventarioFinal: number;
  precioJornada: number | null;
};

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
      const precioJornada =
        data.precio_jornada != null ? Number(data.precio_jornada) : null;

      const prev = byProduct.get(productoId);
      byProduct.set(productoId, {
        inventarioInicial: (prev?.inventarioInicial ?? 0) + inicial,
        inventarioFinal: (prev?.inventarioFinal ?? 0) + final,
        precioJornada:
          prev?.precioJornada != null
            ? prev.precioJornada
            : precioJornada,
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

const aggregateCortesiasFromVentas = (
  ventas: Array<Record<string, unknown>>,
): Map<string, number> => {
  const byProduct = new Map<string, number>();

  for (const venta of ventas) {
    const lineas = Array.isArray(venta.lineasVenta) ? venta.lineasVenta : [];
    for (const linea of lineas) {
      const row = linea as Record<string, unknown>;
      const productoId = String(row.producto ?? "");
      if (!productoId) continue;
      if (Number(row.precio_actual ?? -1) !== 0) continue;
      const cantidad = Number(row.cantidad ?? 0);
      byProduct.set(productoId, (byProduct.get(productoId) ?? 0) + cantidad);
    }
  }

  return byProduct;
};

const aggregateMontoFromDetalle = (
  ventas: Array<Record<string, unknown>>,
): Map<string, number> => {
  const byProduct = new Map<string, number>();

  for (const venta of ventas) {
    const detalle = Array.isArray(venta.detalle) ? venta.detalle : [];
    for (const linea of detalle) {
      const row = linea as Record<string, unknown>;
      const productoId = String(row.producto ?? "");
      if (!productoId) continue;
      const cantidad = Number(row.cantidad ?? 0);
      const subtotal =
        row.subtotal != null
          ? Number(row.subtotal)
          : roundMoney(Number(row.precio_actual ?? 0) * cantidad);
      byProduct.set(
        productoId,
        roundMoney((byProduct.get(productoId) ?? 0) + subtotal),
      );
    }
  }

  return byProduct;
};

const buildProductosReporte = async (
  concesionId: string,
  stockByProduct: Map<string, StockAgg>,
  cortesiasByProduct: Map<string, number>,
  montoByProduct: Map<string, number>,
): Promise<ReporteProductoRow[]> => {
  const catalog = await productService.listProducts(concesionId);
  const productIds = new Set<string>([
    ...catalog.map((p) => p.id),
    ...stockByProduct.keys(),
    ...cortesiasByProduct.keys(),
    ...montoByProduct.keys(),
  ]);

  const rows: ReporteProductoRow[] = [];

  for (const productoId of productIds) {
    const catalogProduct = catalog.find((p) => p.id === productoId);
    const stock = stockByProduct.get(productoId);
    const precioUnitario = roundMoney(
      stock?.precioJornada ??
        Number((catalogProduct as { precio?: number })?.precio ?? 0),
    );

    rows.push({
      productoId,
      nombre: String(catalogProduct?.nombre ?? "Producto"),
      inventarioInicial: stock?.inventarioInicial ?? 0,
      precioUnitario,
      inventarioFinal: stock?.inventarioFinal ?? 0,
      cortesias: cortesiasByProduct.get(productoId) ?? 0,
      totalVendido: montoByProduct.get(productoId) ?? 0,
    });
  }

  return rows.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
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

const buildReporteForConcesion = async (
  concesion: Record<string, unknown> & { id: string },
  jornada: { fecha: string; numero: number; jornadaId: string },
  sucursalId?: string,
  includeProductos = false,
): Promise<{ productos: ReporteProductoRow[] | null; resumen: ReporteConcesionRow }> => {
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

  if (!includeProductos) {
    return { productos: null, resumen };
  }

  const stockByProduct = await aggregateStockByProduct(inventarios);
  const cortesiasByProduct = aggregateCortesiasFromVentas(ventas);
  const montoByProduct = aggregateMontoFromDetalle(ventas);
  const productos = await buildProductosReporte(
    concesion.id,
    stockByProduct,
    cortesiasByProduct,
    montoByProduct,
  );

  return { productos, resumen };
};

export const buildReporteCortes = async (
  filters: ReporteCortesFilters,
): Promise<ReporteCortes> => {
  let fecha = filters.fecha;
  let jornadaNumero = filters.jornadaNumero;

  if (!fecha || jornadaNumero == null) {
    const primaria = await resolveJornadaPrimaria();
    fecha = fecha ?? primaria.fecha;
    jornadaNumero = jornadaNumero ?? primaria.jornadaNumero;
  }

  const fechaNorm = normalizeFecha(fecha);
  const numero = Number(jornadaNumero);
  const jornadaId = buildJornadaId(fechaNorm, numero);

  const jornada = { fecha: fechaNorm, numero, jornadaId };

  if (filters.concesionId) {
    const concesion = await concessionService.getConcessionById(filters.concesionId);
    const { productos, resumen } = await buildReporteForConcesion(
      concesion as Record<string, unknown> & { id: string },
      jornada,
      filters.sucursalId,
      true,
    );
    return { jornada, productos, resumen: [resumen] };
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
    resumen: resumenRows.sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
  };
};
