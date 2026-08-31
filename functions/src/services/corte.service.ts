import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import * as detalleVentaService from "./detalle-venta.service";
import * as productService from "./product.service";
import * as comboService from "./combo.service";
import * as inventarioService from "./inventario.service";
import { buildJornadaId, ramaFromInventario } from "./asignacion-caja.service";
import { resolveJornadaActiva } from "./jornada.service";
import type { OperationalListFilters } from "../utils/list-filters.util";
import {
  findCorteCerradoHoy,
  todayIsoDate,
} from "./corte-guard.service";
import { isVentaPalcos } from "../utils/venta-palcos.util";

const col = () => firestorePos.collection(COLLECTIONS.CORTES);
const inventariosCol = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export interface CorteListFilters {
  concesionId?: string;
  sucursalId?: string;
  cajaId?: string;
  idUser?: string;
  jornadaId?: string;
}

export const listCortes = async (filters: CorteListFilters = {}) => {
  let query: FirebaseFirestore.Query = col();
  if (filters.concesionId) {
    query = query.where("concesionId", "==", filters.concesionId);
  }
  if (filters.sucursalId) {
    query = query.where("sucursalId", "==", filters.sucursalId);
  }
  if (filters.cajaId) {
    query = query.where("cajaId", "==", filters.cajaId);
  } else if (filters.idUser) {
    query = query.where("idUser", "==", filters.idUser);
  }
  const snap = await query.get();
  let results = snap.docs.map(toData);

  if (filters.jornadaId) {
    const prefix = `${filters.jornadaId}__`;
    const fechaFromJornada = filters.jornadaId.match(
      /^(\d{4}-\d{2}-\d{2})__J\d+$/,
    )?.[1];
    results = results.filter((row) => {
      const c = row as Record<string, unknown>;
      if (c.jornadaId === filters.jornadaId) return true;
      const invId = String(c.inventarioId ?? "");
      if (invId.startsWith(prefix)) return true;
      // Legacy cortes sin jornadaId/inventarioId: match by fecha
      if (
        fechaFromJornada &&
        !c.jornadaId &&
        !c.inventarioId &&
        String(c.fecha ?? "") === fechaFromJornada
      ) {
        return true;
      }
      return false;
    });
  }

  return results;
};

//Prueba deploy de variables y workflow

export const getCorteById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const buildCorteWritePayload = (
  context: {
    concesionId: string;
    sucursalId?: string | null;
    idUser: string;
    ventaId?: string | null;
    cajaId?: string | null;
    cajaNombre?: string | null;
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
    fierabonados?: CorteResumenFierabonados;
    efectivoContado?: number | null;
    diferenciaCaja?: number | null;
    jornadaId?: string | null;
    inventarioId?: string | null;
    tipoCorte?: string | null;
  },
) => ({
  ventaId: context.ventaId ?? null,
  idUser: context.idUser,
  concesionId: context.concesionId,
  sucursalId: context.sucursalId ?? null,
  cajaId: context.cajaId ?? null,
  cajaNombre: context.cajaNombre ?? null,
  jornadaId: data.jornadaId ?? null,
  inventarioId: data.inventarioId ?? null,
  tipoCorte: data.tipoCorte ?? null,
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
  fierabonados: data.fierabonados ?? null,
  efectivoContado: data.efectivoContado ?? null,
  diferenciaCaja: data.diferenciaCaja ?? null,
});

export const createCorte = async (
  context: {
    concesionId: string;
    sucursalId?: string | null;
    idUser: string;
    ventaId?: string | null;
    cajaId?: string | null;
    cajaNombre?: string | null;
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
    fierabonados?: CorteResumenFierabonados;
    efectivoContado?: number | null;
    diferenciaCaja?: number | null;
    jornadaId?: string | null;
    inventarioId?: string | null;
    tipoCorte?: string | null;
  },
) => {
  const payload = {
    ...buildCorteWritePayload(context, data),
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
  if (!doc.exists) {
    throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return toData(updated);
};

export interface CorteResumenProducto {
  productoId: string;
  nombre: string;
  cantidad: number;
  subtotal: number;
  /** Precio real por unidad tal como se registró en la línea de venta. */
  precioUnitario: number;
}

export interface CorteResumenPromociones2x1 {
  montoTotal: number;
  montoDescuento: number;
  unidadesGratis: number;
  cantidadTransacciones: number;
}

export interface CorteResumenFierabonados {
  cantidadUnidades: number;
  montoTotal: number;
  montoDescuento: number;
  cantidadTransacciones: number;
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
  /** Dinero real vendido = efectivo + tarjeta. NO incluye puntos. */
  totalVendido: number;
  totalEfectivo: number;
  totalTarjeta: number;
  /** Monto ($) canjeado con puntos. Informativo: NO se suma al dinero real. */
  totalPuntosMonto: number;
  totalPuntosCanjeados: number;
  ventasConPuntos: number;
  cantidadVentas: number;
  productos: CorteResumenProducto[];
  promociones2x1: CorteResumenPromociones2x1;
  combos: CorteResumenCombos;
  fierabonados: CorteResumenFierabonados;
  /** Efectivo físico contado al cerrar (arqueo). null si el corte no está cerrado. */
  efectivoContado: number | null;
  /** efectivoContado - totalEfectivo. Positivo = sobrante, negativo = faltante. */
  diferenciaCaja: number | null;
  cajaNombre: string | null;
  cajeroNombre: string | null;
  corteCerrado: boolean;
  corteId: string | null;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;

/** @internal exported for unit tests */
export const aggregateTotalsByMetodoPago = (
  ventas: Array<Record<string, unknown>>,
): {
  totalEfectivo: number;
  totalTarjeta: number;
  totalPuntosMonto: number;
  totalPuntosCanjeados: number;
  ventasConPuntos: number;
} => {
  let totalEfectivo = 0;
  let totalTarjeta = 0;
  let totalPuntosMonto = 0;
  let totalPuntosCanjeados = 0;
  let ventasConPuntos = 0;

  for (const venta of ventas) {
    const puntosUsados = Number(venta.puntosUsados ?? 0);
    const montoPuntos = Number(venta.montoPuntos ?? 0);
    const montoEfectivo = venta.montoEfectivo;
    const montoTarjeta = venta.montoTarjeta;
    const ventaTotal = Number(venta.total ?? 0);

    if (puntosUsados > 0) {
      ventasConPuntos += 1;
      totalPuntosCanjeados += puntosUsados;
    }

    if (montoEfectivo != null || montoTarjeta != null || montoPuntos > 0) {
      totalEfectivo = roundMoney(
        totalEfectivo + Number(montoEfectivo ?? 0),
      );
      totalTarjeta = roundMoney(totalTarjeta + Number(montoTarjeta ?? 0));
      // Valor monetario de los puntos canjeados; forma parte del total vendido.
      totalPuntosMonto = roundMoney(totalPuntosMonto + montoPuntos);
      continue;
    }

    const metodo = String(venta.metodoPago ?? "efectivo");
    if (metodo === "tarjeta") {
      totalTarjeta = roundMoney(totalTarjeta + ventaTotal);
    } else {
      totalEfectivo = roundMoney(totalEfectivo + ventaTotal);
    }
  }

  return {
    totalEfectivo,
    totalTarjeta,
    totalPuntosMonto,
    totalPuntosCanjeados,
    ventasConPuntos,
  };
};

/** @internal exported for unit tests */
export const aggregateProductosFromVentas = (
  ventas: Array<Record<string, unknown>>,
  productNames: Map<string, string> = new Map(),
): CorteResumenProducto[] => {
  // Agrupa por producto + precio real por unidad; NUNCA se divide subtotal/cantidad
  // para inventar un precio. Se prioriza `lineasVenta` (líneas crudas del POS con el
  // precio real por unidad, p. ej. 2x1 = 1 uds a $80 + 1 uds a $0). Solo se recurre a
  // `detalle` (fusionado) para ventas históricas sin `lineasVenta`.
  const byProductPrice = new Map<
    string,
    { productoId: string; precioUnitario: number; cantidad: number; subtotal: number }
  >();

  for (const venta of ventas) {
    const lineasVenta = Array.isArray(venta.lineasVenta)
      ? (venta.lineasVenta as Array<Record<string, unknown>>)
      : [];
    const useLineasVenta = lineasVenta.length > 0;
    const source = useLineasVenta
      ? lineasVenta
      : Array.isArray(venta.detalle)
        ? (venta.detalle as Array<Record<string, unknown>>)
        : [];

    for (const linea of source) {
      const row = linea;
      // En `lineasVenta` los combos van como líneas `combo` (sin `producto`); se omiten
      // aquí porque el desglose de combos se calcula aparte.
      const productoId = String(row.producto ?? "");
      if (!productoId) continue;

      const cantidad = Number(row.cantidad ?? 0);
      const precioUnitario =
        row.precio_actual != null
          ? roundMoney(Number(row.precio_actual))
          : row.subtotal != null && cantidad > 0
            ? roundMoney(Number(row.subtotal) / cantidad)
            : 0;
      const subtotal =
        row.subtotal != null
          ? Number(row.subtotal)
          : roundMoney(precioUnitario * cantidad);

      const key = `${productoId}|${precioUnitario}`;
      const prev = byProductPrice.get(key);
      byProductPrice.set(key, {
        productoId,
        precioUnitario,
        cantidad: (prev?.cantidad ?? 0) + cantidad,
        subtotal: roundMoney((prev?.subtotal ?? 0) + subtotal),
      });
    }
  }

  return Array.from(byProductPrice.values())
    .map((stats) => ({
      productoId: stats.productoId,
      nombre: productNames.get(stats.productoId) ?? "Producto",
      cantidad: stats.cantidad,
      subtotal: stats.subtotal,
      precioUnitario: stats.precioUnitario,
    }))
    .sort((a, b) => b.subtotal - a.subtotal);
};

/** @internal exported for unit tests */
export const aggregatePromociones2x1FromVentas = (
  ventas: Array<Record<string, unknown>>,
): CorteResumenPromociones2x1 => {
  let montoTotal = 0;
  let montoDescuento = 0;
  let unidadesGratis = 0;
  let cantidadTransacciones = 0;

  for (const venta of ventas) {
    const abonado = venta.abonado as Record<string, unknown> | null | undefined;
    if (!abonado || Number(abonado.unidadesGratis ?? 0) <= 0) {
      continue;
    }
    if (Number(abonado.montoDescuento ?? 0) <= 0) {
      continue;
    }

    cantidadTransacciones += 1;
    montoTotal = roundMoney(montoTotal + Number(abonado.montoTotal ?? 0));
    montoDescuento = roundMoney(
      montoDescuento + Number(abonado.montoDescuento ?? 0),
    );
    unidadesGratis += Number(abonado.unidadesGratis ?? 0);
  }

  return {
    montoTotal,
    montoDescuento,
    unidadesGratis,
    cantidadTransacciones,
  };
};

export type ReporteTipoVentaTipo =
  | "normal"
  | "abonado"
  | "abonado_puntos"
  | "normal_puntos";

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

const REPORTE_TIPOS_VENTA_META: Record<
  ReporteTipoVentaTipo,
  { etiqueta: string; descripcion: string }
> = {
  normal: {
    etiqueta: "Venta normal",
    descripcion: "Cliente público, precio de lista, sin puntos",
  },
  abonado: {
    etiqueta: "Venta abonado",
    descripcion:
      "Beneficio de temporada (precio especial, 2x1, etc.), pago en efectivo o tarjeta",
  },
  abonado_puntos: {
    etiqueta: "Abonado con puntos",
    descripcion: "Beneficio abonado con canje total o parcial con puntos",
  },
  normal_puntos: {
    etiqueta: "Cliente con puntos",
    descripcion: "Sin beneficio abonado, pago con puntos",
  },
};

const emptyTipoVentaBucket = (): ReporteTipoVentaBucket => ({
  transacciones: 0,
  efectivo: 0,
  tarjeta: 0,
  puntosMonto: 0,
  puntosCanjeados: 0,
  valorTotal: 0,
  descuentoAbonado: 0,
});

/** @internal exported for unit tests */
export const isVentaAbonado = (venta: Record<string, unknown>): boolean => {
  const abonado = venta.abonado as Record<string, unknown> | null | undefined;
  return (
    abonado != null &&
    (Number(abonado.montoDescuento ?? 0) > 0 ||
      Number(abonado.unidadesGratis ?? 0) > 0)
  );
};

export interface ProductoReporteAgg {
  cantidadRegular: number;
  cantidadAbonado: number;
  ventasRegular: number;
  ventasAbonado: number;
  cortesias: number;
  puntosCanjeados: number;
  ventasTotales: number;
  /** Parte de ventasTotales originada en VIP / VIP Stripe (palcos). */
  ventaPalcos: number;
}

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

/** @internal exported for unit tests */
export const aggregateProductoReporteFromVentas = (
  ventas: Array<Record<string, unknown>>,
): Map<string, ProductoReporteAgg> => {
  const byProduct = new Map<string, ProductoReporteAgg>();

  for (const venta of ventas) {
    const esAbonado = isVentaAbonado(venta);
    const esPalcos = isVentaPalcos(venta);
    const ventaTotal = Number(venta.total ?? 0);
    const montoPuntos = Number(venta.montoPuntos ?? 0);

    const detalle = Array.isArray(venta.detalle)
      ? (venta.detalle as Array<Record<string, unknown>>)
      : [];
    const lineasVenta = Array.isArray(venta.lineasVenta)
      ? (venta.lineasVenta as Array<Record<string, unknown>>)
      : [];
    const source = detalle.length > 0 ? detalle : lineasVenta;

    for (const linea of source) {
      const productoId = String(linea.producto ?? "");
      if (!productoId) continue;

      const cantidad = Number(linea.cantidad ?? 0);
      const precio = Number(linea.precio_actual ?? 0);
      const subtotal =
        linea.subtotal != null
          ? Number(linea.subtotal)
          : roundMoney(precio * cantidad);

      const prev = byProduct.get(productoId) ?? emptyProductoReporteAgg();

      if (precio === 0) {
        prev.cortesias += cantidad;
      } else if (esAbonado) {
        prev.cantidadAbonado += cantidad;
        prev.ventasAbonado = roundMoney(prev.ventasAbonado + subtotal);
      } else {
        prev.cantidadRegular += cantidad;
        prev.ventasRegular = roundMoney(prev.ventasRegular + subtotal);
      }

      prev.ventasTotales = roundMoney(prev.ventasTotales + subtotal);
      if (esPalcos) {
        prev.ventaPalcos = roundMoney(prev.ventaPalcos + subtotal);
      }

      if (montoPuntos > 0 && ventaTotal > 0) {
        prev.puntosCanjeados = roundMoney(
          prev.puntosCanjeados + (subtotal / ventaTotal) * montoPuntos,
        );
      }

      byProduct.set(productoId, prev);
    }
  }

  return byProduct;
};

export interface ReporteProductoTotalesRow {
  cantidadRegular: number;
  cantidadAbonado: number;
  ventasRegular: number;
  ventasAbonado: number;
  cortesias: number;
  puntosCanjeados: number;
  ventasTotales: number;
  ventaPalcos: number;
  dineroReal: number;
}

/** @internal exported for unit tests */
export const buildReporteProductoTotales = (
  rows: ProductoReporteAgg[],
): ReporteProductoTotalesRow => {
  const totals = rows.reduce(
    (acc, row) => ({
      cantidadRegular: acc.cantidadRegular + row.cantidadRegular,
      cantidadAbonado: acc.cantidadAbonado + row.cantidadAbonado,
      ventasRegular: roundMoney(acc.ventasRegular + row.ventasRegular),
      ventasAbonado: roundMoney(acc.ventasAbonado + row.ventasAbonado),
      cortesias: acc.cortesias + row.cortesias,
      puntosCanjeados: roundMoney(acc.puntosCanjeados + row.puntosCanjeados),
      ventasTotales: roundMoney(acc.ventasTotales + row.ventasTotales),
      ventaPalcos: roundMoney(acc.ventaPalcos + row.ventaPalcos),
    }),
    emptyProductoReporteAgg(),
  );

  return {
    ...totals,
    dineroReal: roundMoney(totals.ventasTotales - totals.puntosCanjeados),
  };
};

/** @internal exported for unit tests */
export const classifyVentaTipo = (
  venta: Record<string, unknown>,
): ReporteTipoVentaTipo => {
  const abonado = venta.abonado as Record<string, unknown> | null | undefined;
  const esAbonado =
    abonado != null &&
    (Number(abonado.montoDescuento ?? 0) > 0 ||
      Number(abonado.unidadesGratis ?? 0) > 0);

  const puntosUsados = Number(venta.puntosUsados ?? 0);
  const montoPuntos = Number(venta.montoPuntos ?? 0);
  const metodoPago = String(venta.metodoPago ?? "");
  const usaPuntos =
    puntosUsados > 0 || montoPuntos > 0 || metodoPago === "puntos";

  if (esAbonado && usaPuntos) return "abonado_puntos";
  if (esAbonado) return "abonado";
  if (usaPuntos) return "normal_puntos";
  return "normal";
};

/** @internal exported for unit tests */
export const extractMontosVenta = (
  venta: Record<string, unknown>,
): {
  efectivo: number;
  tarjeta: number;
  puntosMonto: number;
  puntosCanjeados: number;
  valorTotal: number;
} => {
  const puntosUsados = Number(venta.puntosUsados ?? 0);
  const montoPuntos = Number(venta.montoPuntos ?? 0);
  const montoEfectivo = venta.montoEfectivo;
  const montoTarjeta = venta.montoTarjeta;
  const ventaTotal = Number(venta.total ?? 0);

  if (montoEfectivo != null || montoTarjeta != null || montoPuntos > 0) {
    return {
      efectivo: roundMoney(Number(montoEfectivo ?? 0)),
      tarjeta: roundMoney(Number(montoTarjeta ?? 0)),
      puntosMonto: roundMoney(montoPuntos),
      puntosCanjeados: puntosUsados > 0 ? puntosUsados : 0,
      valorTotal: roundMoney(ventaTotal),
    };
  }

  const metodo = String(venta.metodoPago ?? "efectivo");
  if (metodo === "tarjeta") {
    return {
      efectivo: 0,
      tarjeta: roundMoney(ventaTotal),
      puntosMonto: 0,
      puntosCanjeados: 0,
      valorTotal: roundMoney(ventaTotal),
    };
  }

  return {
    efectivo: roundMoney(ventaTotal),
    tarjeta: 0,
    puntosMonto: 0,
    puntosCanjeados: 0,
    valorTotal: roundMoney(ventaTotal),
  };
};

/** @internal exported for unit tests */
export const aggregateTiposVentaFromVentas = (
  ventas: Array<Record<string, unknown>>,
): ReporteTipoVentaRow[] => {
  const buckets = new Map<ReporteTipoVentaTipo, ReporteTipoVentaBucket>();
  const tipos: ReporteTipoVentaTipo[] = [
    "normal",
    "abonado",
    "abonado_puntos",
    "normal_puntos",
  ];
  for (const tipo of tipos) {
    buckets.set(tipo, emptyTipoVentaBucket());
  }

  for (const venta of ventas) {
    const tipo = classifyVentaTipo(venta);
    const bucket = buckets.get(tipo)!;
    const montos = extractMontosVenta(venta);

    bucket.transacciones += 1;
    bucket.efectivo = roundMoney(bucket.efectivo + montos.efectivo);
    bucket.tarjeta = roundMoney(bucket.tarjeta + montos.tarjeta);
    bucket.puntosMonto = roundMoney(bucket.puntosMonto + montos.puntosMonto);
    bucket.puntosCanjeados += montos.puntosCanjeados;
    bucket.valorTotal = roundMoney(bucket.valorTotal + montos.valorTotal);

    if (tipo === "abonado" || tipo === "abonado_puntos") {
      const abonado = venta.abonado as Record<string, unknown> | null | undefined;
      bucket.descuentoAbonado = roundMoney(
        bucket.descuentoAbonado + Number(abonado?.montoDescuento ?? 0),
      );
    }
  }

  return tipos.map((tipo) => {
    const meta = REPORTE_TIPOS_VENTA_META[tipo];
    return {
      tipo,
      etiqueta: meta.etiqueta,
      descripcion: meta.descripcion,
      ...buckets.get(tipo)!,
    };
  });
};

/** @internal exported for unit tests */
export const aggregateFierabonadosFromVentas = (
  ventas: Array<Record<string, unknown>>,
): CorteResumenFierabonados => {
  let cantidadUnidades = 0;
  let montoTotal = 0;
  let montoDescuento = 0;
  let cantidadTransacciones = 0;

  for (const venta of ventas) {
    const abonado = venta.abonado as Record<string, unknown> | null | undefined;
    if (
      !abonado ||
      Number(abonado.montoDescuento ?? 0) <= 0 ||
      Number(abonado.unidadesGratis ?? 0) > 0
    ) {
      continue;
    }

    const descuento = Number(abonado.montoDescuento ?? 0);
    const total = Number(abonado.montoTotal ?? 0);
    if (descuento <= 0 && total <= 0) {
      continue;
    }

    cantidadTransacciones += 1;
    montoTotal = roundMoney(montoTotal + total);
    montoDescuento = roundMoney(montoDescuento + descuento);

    const lineas = Array.isArray(venta.lineasVenta)
      ? (venta.lineasVenta as Array<Record<string, unknown>>)
      : [];
    for (const linea of lineas) {
      if (linea.combo) continue;
      if (linea.producto) {
        cantidadUnidades += Number(linea.cantidad ?? 0);
      }
    }
  }

  return {
    cantidadUnidades,
    montoTotal,
    montoDescuento,
    cantidadTransacciones,
  };
};

/** @internal exported for unit tests */
export const aggregateCombosFromVentas = (
  ventas: Array<Record<string, unknown>>,
  comboNames: Map<string, string> = new Map(),
): CorteResumenCombos => {
  const byCombo = new Map<string, { cantidadVendidos: number; montoTotal: number }>();

  for (const venta of ventas) {
    const lineas = Array.isArray(venta.lineasVenta) ? venta.lineasVenta : [];
    for (const linea of lineas) {
      const row = linea as Record<string, unknown>;
      const comboId = String(row.combo ?? "");
      if (!comboId) continue;

      const cantidad = Number(row.cantidad ?? 0);
      const precio = Number(row.precio_actual ?? 0);
      const subtotal = roundMoney(cantidad * precio);
      const prev = byCombo.get(comboId);
      byCombo.set(comboId, {
        cantidadVendidos: (prev?.cantidadVendidos ?? 0) + cantidad,
        montoTotal: roundMoney((prev?.montoTotal ?? 0) + subtotal),
      });
    }
  }

  const items = Array.from(byCombo.entries())
    .map(([comboId, stats]) => ({
      comboId,
      nombre: comboNames.get(comboId) ?? "Combo",
      cantidadVendidos: stats.cantidadVendidos,
      montoTotal: stats.montoTotal,
    }))
    .sort((a, b) => b.montoTotal - a.montoTotal);

  const montoTotal = roundMoney(
    items.reduce((sum, item) => sum + item.montoTotal, 0),
  );
  const cantidadVendidos = items.reduce(
    (sum, item) => sum + item.cantidadVendidos,
    0,
  );

  return { montoTotal, cantidadVendidos, items };
};

/**
 * Arqueo de caja: compara el efectivo contado físicamente con el esperado.
 * @internal exported for unit tests
 */
export const computeDiferenciaCaja = (
  efectivoContado: number | null | undefined,
  totalEfectivo: number,
): { efectivoContado: number | null; diferenciaCaja: number | null } => {
  if (efectivoContado == null) {
    return { efectivoContado: null, diferenciaCaja: null };
  }
  const contado = roundMoney(efectivoContado);
  // Positivo = sobrante, negativo = faltante.
  return {
    efectivoContado: contado,
    diferenciaCaja: roundMoney(contado - totalEfectivo),
  };
};

export const buildCorteResumen = async (
  filters: OperationalListFilters,
): Promise<CorteResumen> => {
  const ventasRaw = await detalleVentaService.listDetalleVentas(filters);
  const ventas = await detalleVentaService.attachDetalleToComprobantes(ventasRaw);
  const products = filters.concesionId
    ? await productService.listProducts(filters.concesionId)
    : await productService.listProducts();

  const productNames = new Map<string, string>();
  for (const product of products) {
    productNames.set(
      product.id,
      String(product.nombre ?? "Producto"),
    );
  }

  const productos = aggregateProductosFromVentas(ventas, productNames);

  const combosList = filters.concesionId
    ? await comboService.listCombos({
        concesionId: filters.concesionId,
        includeInactive: true,
      })
    : await comboService.listCombos({ includeInactive: true });
  const comboNames = new Map<string, string>();
  for (const combo of combosList) {
    comboNames.set(
      combo.id,
      String((combo as { titulo?: string }).titulo ?? "Combo"),
    );
  }

  const promociones2x1 = aggregatePromociones2x1FromVentas(ventas);
  const combos = aggregateCombosFromVentas(ventas, comboNames);
  const fierabonados = aggregateFierabonadosFromVentas(ventas);

  const {
    totalEfectivo,
    totalTarjeta,
    totalPuntosMonto,
    totalPuntosCanjeados,
    ventasConPuntos,
  } = aggregateTotalsByMetodoPago(ventas);

  // Dinero real recibido = efectivo + tarjeta. Los puntos NO son dinero:
  // aunque venta.total incluye montoPuntos, se excluye del total de dinero.
  const totalVendido = roundMoney(totalEfectivo + totalTarjeta);

  const firstVenta = ventas[0] as Record<string, unknown> | undefined;
  const cajaNombre = firstVenta?.cajaNombre ? String(firstVenta.cajaNombre) : null;
  const cajeroNombre = firstVenta?.cajeroNombre
    ? String(firstVenta.cajeroNombre)
    : null;
  const corteCerrado = await findCorteCerradoHoy(filters);

  // Corte cerrado: prioriza el desglose persistido en el documento del corte;
  // recalcula solo como respaldo para cortes históricos sin desglose guardado.
  if (corteCerrado) {
    const doc = corteCerrado as Record<string, unknown>;
    return {
      totalVendido: doc.totalReal != null ? Number(doc.totalReal) : totalVendido,
      totalEfectivo:
        doc.totalEfectivo != null ? Number(doc.totalEfectivo) : totalEfectivo,
      totalTarjeta:
        doc.totalTarjeta != null ? Number(doc.totalTarjeta) : totalTarjeta,
      totalPuntosMonto:
        doc.totalPuntosMonto != null
          ? Number(doc.totalPuntosMonto)
          : totalPuntosMonto,
      totalPuntosCanjeados:
        doc.totalPuntosCanjeados != null
          ? Number(doc.totalPuntosCanjeados)
          : totalPuntosCanjeados,
      ventasConPuntos:
        doc.ventasConPuntos != null
          ? Number(doc.ventasConPuntos)
          : ventasConPuntos,
      cantidadVentas:
        doc.cantidadVentas != null ? Number(doc.cantidadVentas) : ventas.length,
      productos: Array.isArray(doc.productos)
        ? (doc.productos as CorteResumenProducto[])
        : productos,
      promociones2x1:
        (doc.promociones2x1 as CorteResumenPromociones2x1 | null) ??
        promociones2x1,
      combos: (doc.combos as CorteResumenCombos | null) ?? combos,
      fierabonados:
        (doc.fierabonados as CorteResumenFierabonados | null) ?? fierabonados,
      efectivoContado:
        doc.efectivoContado != null ? Number(doc.efectivoContado) : null,
      diferenciaCaja:
        doc.diferenciaCaja != null ? Number(doc.diferenciaCaja) : null,
      cajaNombre,
      cajeroNombre,
      corteCerrado: true,
      corteId: String(corteCerrado.id),
    };
  }

  return {
    totalVendido,
    totalEfectivo,
    totalTarjeta,
    totalPuntosMonto,
    totalPuntosCanjeados,
    ventasConPuntos,
    cantidadVentas: ventas.length,
    productos,
    promociones2x1,
    combos,
    fierabonados,
    efectivoContado: null,
    diferenciaCaja: null,
    cajaNombre,
    cajeroNombre,
    corteCerrado: false,
    corteId: null,
  };
};

export interface ConteoFinalProducto {
  productoId: string;
  cantidadFinal: number;
}

/**
 * Cierre de día por conteo físico (sucursales de cervecería sin vendedores):
 * el admin captura el inventario final de cada producto y la venta se calcula
 * como (cantidad_inicial - cantidad_final) x precio.
 */
export const cerrarCortePorConteo = async (
  context: {
    concesionId: string;
    sucursalId: string;
    idUser: string;
  },
  data: {
    productos: ConteoFinalProducto[];
    comentarios?: string;
    efectivoContado?: number;
  },
) => {
  const sucursalDoc = await firestorePos
    .collection(COLLECTIONS.SUCURSALES)
    .doc(context.sucursalId)
    .get();
  if (!sucursalDoc.exists) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  if (sucursalDoc.data()?.modo_operacion !== "CONTEO") {
    throw new ApiError(
      400,
      "La sucursal no opera con corte por conteo",
      true,
      "INVALID_SUCURSAL_MODO",
    );
  }

  const yaCerrado = await findCorteCerradoHoy({
    concesionId: context.concesionId,
    sucursalId: context.sucursalId,
  });
  if (yaCerrado) {
    throw new ApiError(
      409,
      "Ya existe un corte cerrado para hoy",
      true,
      "CORTE_ALREADY_CLOSED",
    );
  }

  const { inventario } = await inventarioService.getInventarioJornadaActiva(
    context.sucursalId,
    true,
  );
  if (!inventario) {
    throw new ApiError(
      404,
      "No hay inventario de jornada activa para la sucursal",
      true,
      "NO_ACTIVE_INVENTORY",
    );
  }

  const inv = inventario as Record<string, unknown> & { id: string };
  if (inv.concesion_id && inv.concesion_id !== context.concesionId) {
    throw new ApiError(
      403,
      "El inventario no pertenece a tu concesión",
      true,
      "FORBIDDEN",
    );
  }

  const invProductos = (
    Array.isArray(inv.productos) ? inv.productos : []
  ) as Array<Record<string, unknown> & { id: string }>;

  const invByProducto = new Map<string, Record<string, unknown> & { id: string }>();
  for (const prod of invProductos) {
    invByProducto.set(String(prod.producto_id ?? prod.id), prod);
  }

  const conteoByProducto = new Map<string, number>();
  for (const item of data.productos) {
    if (!invByProducto.has(item.productoId)) {
      throw new ApiError(
        400,
        `El producto ${item.productoId} no está en el inventario de la jornada`,
        true,
        "INVALID_PRODUCT",
      );
    }
    conteoByProducto.set(item.productoId, Number(item.cantidadFinal));
  }

  const catalog = await productService.listProducts(context.concesionId, true);
  const catalogById = new Map<string, Record<string, unknown>>();
  for (const product of catalog) {
    catalogById.set(String(product.id), product as Record<string, unknown>);
  }

  const productosCorte: CorteResumenProducto[] = [];
  let totalVenta = 0;

  for (const invProd of invProductos) {
    const productoId = String(invProd.producto_id ?? invProd.id);
    const inicial = Number(invProd.cantidad_inicial ?? 0);
    const finalActual = Number(invProd.cantidad_final ?? inicial);
    const conteo = conteoByProducto.get(productoId);
    const cantidadFinal = conteo ?? finalActual;
    const catalogProd = catalogById.get(productoId);
    const nombre = String(catalogProd?.nombre ?? "Producto");

    if (
      !Number.isFinite(cantidadFinal) ||
      cantidadFinal < 0 ||
      cantidadFinal > inicial
    ) {
      throw new ApiError(
        400,
        `Inventario final inválido para "${nombre}": debe estar entre 0 y ${inicial}`,
        true,
        "INVALID_CONTEO",
      );
    }

    // Persistir el conteo como cantidad_final y dejar bitácora del ajuste.
    if (conteo !== undefined && conteo !== finalActual) {
      await firestorePos
        .collection(COLLECTIONS.INVENTARIOS)
        .doc(inv.id)
        .collection(SUBCOLLECTIONS.PRODUCTOS)
        .doc(invProd.id)
        .set(
          {
            cantidad_final: conteo,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      await inventarioService.logMovimiento(inv.id, {
        tipo: "AJUSTE",
        producto_id: productoId,
        cantidad: conteo - finalActual,
        cantidad_anterior: finalActual,
        cantidad_nueva: conteo,
        sucursal_id: context.sucursalId,
        idUser: context.idUser,
        motivo: "Conteo final de corte",
      });
    }

    const vendido = inicial - cantidadFinal;
    if (vendido <= 0) continue;

    const precioJornada = invProd.precio_jornada;
    const precio =
      precioJornada != null
        ? Number(precioJornada)
        : Number(catalogProd?.precio ?? 0);
    const subtotal = roundMoney(vendido * precio);

    productosCorte.push({
      productoId,
      nombre,
      cantidad: vendido,
      subtotal,
      precioUnitario: roundMoney(precio),
    });
    totalVenta = roundMoney(totalVenta + subtotal);
  }

  productosCorte.sort((a, b) => b.subtotal - a.subtotal);

  const { efectivoContado, diferenciaCaja } = computeDiferenciaCaja(
    data.efectivoContado,
    totalVenta,
  );

  const jornadaId = buildJornadaId(
    String(inv.jornada_fecha ?? ""),
    Number(inv.jornada_numero ?? 0),
    ramaFromInventario(inv),
  );

  return createCorte(
    {
      concesionId: context.concesionId,
      sucursalId: context.sucursalId,
      idUser: context.idUser,
      ventaId: null,
    },
    {
      fecha: todayIsoDate(),
      comentarios: data.comentarios,
      estatus: "CERRADO",
      // Sin desglose por método de pago: la venta calculada se asume efectivo.
      totalReal: totalVenta,
      totalCaja: totalVenta,
      totalEfectivo: totalVenta,
      totalTarjeta: 0,
      productos: productosCorte,
      efectivoContado,
      diferenciaCaja,
      jornadaId,
      inventarioId: inv.id,
      tipoCorte: "CONTEO",
    },
  );
};

export const cerrarCorte = async (
  context: {
    concesionId: string;
    sucursalId?: string | null;
    idUser: string;
  },
  filters: OperationalListFilters,
  data: { comentarios?: string; efectivoContado?: number } = {},
) => {
  if (!filters.cajaId) {
    throw new ApiError(
      400,
      "Debes tener una caja asignada para cerrar el corte",
      true,
      "MISSING_CAJA",
    );
  }

  const resumenFilters: OperationalListFilters = {
    ...filters,
    idUser: filters.idUser ?? context.idUser,
  };
  const resumen = await buildCorteResumen(resumenFilters);
  if (resumen.corteCerrado) {
    throw new ApiError(
      409,
      "Ya existe un corte cerrado para hoy",
      true,
      "CORTE_ALREADY_CLOSED",
    );
  }

  // totalReal = dinero real (efectivo + tarjeta, sin puntos).
  // totalCaja = SOLO efectivo físico en el cajón.
  const totalReal = resumen.totalVendido;
  const totalCaja = resumen.totalEfectivo;
  const { efectivoContado, diferenciaCaja } = computeDiferenciaCaja(
    data.efectivoContado,
    resumen.totalEfectivo,
  );

  let jornadaId: string | null = null;
  const inventarioId = filters.inventarioId ?? null;
  if (inventarioId) {
    const invDoc = await inventariosCol().doc(inventarioId).get();
    if (invDoc.exists) {
      const inv = invDoc.data() ?? {};
      jornadaId = buildJornadaId(
        String(inv.jornada_fecha ?? ""),
        Number(inv.jornada_numero ?? 0),
        ramaFromInventario(inv),
      );
    }
  } else {
    try {
      const activa = await resolveJornadaActiva("varonil");
      jornadaId = buildJornadaId(activa.fecha, activa.jornadaNumero, activa.rama);
    } catch {
      try {
        const femenil = await resolveJornadaActiva("femenil");
        jornadaId = buildJornadaId(
          femenil.fecha,
          femenil.jornadaNumero,
          femenil.rama,
        );
      } catch {
        jornadaId = null;
      }
    }
  }

  return createCorte(
    {
      concesionId: context.concesionId,
      sucursalId: context.sucursalId ?? null,
      idUser: context.idUser,
      ventaId: null,
      cajaId: filters.cajaId ?? null,
      cajaNombre: resumen.cajaNombre,
    },
    {
      fecha: todayIsoDate(),
      comentarios: data.comentarios,
      estatus: "CERRADO",
      totalReal,
      totalCaja,
      totalEfectivo: resumen.totalEfectivo,
      totalTarjeta: resumen.totalTarjeta,
      totalPuntosMonto: resumen.totalPuntosMonto,
      totalPuntosCanjeados: resumen.totalPuntosCanjeados,
      ventasConPuntos: resumen.ventasConPuntos,
      cantidadVentas: resumen.cantidadVentas,
      productos: resumen.productos,
      promociones2x1: resumen.promociones2x1,
      combos: resumen.combos,
      fierabonados: resumen.fierabonados,
      efectivoContado,
      diferenciaCaja,
      jornadaId,
      inventarioId,
    },
  );
};
