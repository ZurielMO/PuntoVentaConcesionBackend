import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import * as detalleVentaService from "./detalle-venta.service";
import * as productService from "./product.service";
import * as comboService from "./combo.service";
import type { OperationalListFilters } from "../utils/list-filters.util";
import {
  findCorteCerradoHoy,
  todayIsoDate,
} from "./corte-guard.service";

const col = () => firestorePos.collection(COLLECTIONS.CORTES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export interface CorteListFilters {
  concesionId?: string;
  sucursalId?: string;
  idUser?: string;
  cajaId?: string;
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
  return snap.docs.map(toData);
};

export const getCorteById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Corte no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

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
  },
) => {
  const payload = {
    ventaId: context.ventaId ?? null,
    idUser: context.idUser,
    concesionId: context.concesionId,
    sucursalId: context.sucursalId ?? null,
    cajaId: context.cajaId ?? null,
    cajaNombre: context.cajaNombre ?? null,
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
    if (!abonado || String(abonado.benefitId ?? "") !== ICE_2X1_BENEFIT_ID) {
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
      String(abonado.benefitId ?? "") !== CERVEZA_ABONADO_BENEFIT_ID
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

export const ICE_2X1_BENEFIT_ID = "ice-2x1";
export const CERVEZA_ABONADO_BENEFIT_ID = "cerveza-precio-abonado";

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

  const resumen = await buildCorteResumen(filters);
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
    },
  );
};
