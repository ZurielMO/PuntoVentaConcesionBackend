export const LEGACY_CALCULATION_VERSION = "legacy-v1" as const;
export const CALCULATION_VERSION = "cortes-v2" as const;

export type EstatusVenta =
  | "VALIDA"
  | "CANCELADA"
  | "REEMBOLSADA"
  | "REEMBOLSADA_PARCIAL";

export interface LineaVentaNormalizada {
  productoId?: string;
  comboId?: string;
  nombre?: string;
  cantidad: number;
  precioUnitario?: number;
  precioReferencia?: number;
  subtotal?: number;
  esCortesia?: boolean;
  esMerma?: boolean;
}

export interface PromocionNormalizada {
  id: string;
  nombre: string;
  montoTotal: number;
  montoDescuento: number;
  unidadesGratis: number;
}

export interface VentaNormalizada {
  id?: string;
  calculationVersion: string;
  estatus: EstatusVenta;
  importeBruto: number;
  efectivo: number;
  tarjeta: number;
  valorPuntos: number;
  cantidadPuntos: number;
  descuentoPromocion: number;
  descuentoAbonado: number;
  unidades: number;
  abonado?: boolean;
  lineas: LineaVentaNormalizada[];
  inventarioLineas?: LineaVentaNormalizada[];
  promociones?: PromocionNormalizada[];
  hora?: string | null;
  soloInventario?: boolean;
  reembolso?: {
    efectivo?: number;
    tarjeta?: number;
    valorPuntos?: number;
    cantidadPuntos?: number;
  };
  warnings?: string[];
}

export type TipoMovimientoCaja =
  | "ENTRADA"
  | "SALIDA"
  | "RETIRO"
  | "DEPOSITO"
  | "DEVOLUCION_EFECTIVO"
  | "AJUSTE_AUTORIZADO";

export interface CorteCalculationInput {
  ventas: readonly VentaNormalizada[];
  fondoInicial?: number;
  movimientosCaja?: readonly { tipo: TipoMovimientoCaja; monto: number }[];
  efectivoContado?: number | null;
  porcentajeComision?: number;
}

export interface CalcularComprobantesOptions
  extends Omit<CorteCalculationInput, "ventas"> {
  productNames?: ReadonlyMap<string, string>;
  comboNames?: ReadonlyMap<string, string>;
}

const shiftDecimal = (value: number, places: number): number => {
  const [coefficient, exponent = "0"] = value.toString().split("e");
  return Number(`${coefficient}e${Number(exponent) + places}`);
};

export const roundMoney = (value: number): number => {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(shiftDecimal(Math.abs(value), 2)) / 100;
};

const quantity = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const amount = (value: unknown): number => roundMoney(quantity(value));
const isNonnegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const roundCommission = (base: number, percentage: number): number => {
  const baseCents = Math.round(shiftDecimal(base, 2));
  const percentageBasisPoints = Math.round(shiftDecimal(percentage, 2));
  return Math.floor((baseCents * percentageBasisPoints + 5_000) / 10_000) / 100;
};

type ProductoPrecioAgg = {
  productoId: string;
  nombre: string;
  cantidad: number;
  subtotal: number;
  precioUnitario: number;
};

type ProductoReporteAgg = {
  productoId: string;
  nombre: string;
  cantidadRegular: number;
  cantidadAbonado: number;
  ventasRegular: number;
  ventasAbonado: number;
  cortesias: number;
  puntosCanjeados: number;
  ventasTotales: number;
};

type InventarioAgg = {
  productoId: string;
  nombre: string;
  vendidas: number;
  cortesias: number;
  merma: number;
};

const lineSubtotal = (linea: LineaVentaNormalizada): number =>
  linea.subtotal != null
    ? amount(linea.subtotal)
    : roundMoney(quantity(linea.cantidad) * amount(linea.precioUnitario));

export const calcularCorte = (input: CorteCalculationInput) => {
  let ventasBrutas = 0;
  let descuentosPromocion = 0;
  let descuentosAbonado = 0;
  let cancelaciones = 0;
  let reembolsos = 0;
  let efectivoBruto = 0;
  let tarjetaBruta = 0;
  let puntosBrutos = 0;
  let puntosCantidad = 0;
  let efectivoRevertido = 0;
  let tarjetaRevertida = 0;
  let puntosRevertidos = 0;
  let puntosCantidadRevertida = 0;
  let cantidadTickets = 0;
  let cantidadUnidades = 0;
  let ventasConPuntos = 0;
  const abonados = { operaciones: 0, unidades: 0, importeCobrado: 0, descuentoOtorgado: 0 };
  const cortesias = { cantidad: 0, valorTeorico: 0 };
  const merma = { cantidad: 0, valorTeorico: 0, items: [] as Array<{ productoId: string; nombre: string; cantidad: number; valorTeorico: number }> };
  const warnings = new Set<string>();
  const incidencias: Array<{ codigo: string; ventaId?: string; linea?: number; bloqueante?: boolean }> = [];
  const productos = new Map<string, ProductoPrecioAgg>();
  const productoReporte = new Map<string, ProductoReporteAgg>();
  const inventario = new Map<string, InventarioAgg>();
  const promociones = new Map<string, PromocionNormalizada & { cantidadTransacciones: number }>();
  const combos = new Map<string, { comboId: string; nombre: string; cantidadVendidos: number; montoTotal: number }>();
  const ventasPorHora = new Map<string, { hora: string; ventasNetas: number; dineroReal: number; tickets: number }>();

  const addMerma = (linea: LineaVentaNormalizada): void => {
    const cantidad = quantity(linea.cantidad);
    if (cantidad <= 0) return;
    const productoId = linea.productoId ?? "sin-producto";
    const nombre = linea.nombre ?? "Producto";
    const valorTeorico = roundMoney(cantidad * amount(linea.precioReferencia ?? linea.precioUnitario));
    merma.cantidad += cantidad;
    merma.valorTeorico = roundMoney(merma.valorTeorico + valorTeorico);
    const existing = merma.items.find((item) => item.productoId === productoId);
    if (existing) {
      existing.cantidad += cantidad;
      existing.valorTeorico = roundMoney(existing.valorTeorico + valorTeorico);
    } else {
      merma.items.push({ productoId, nombre, cantidad, valorTeorico });
    }
    const stock = inventario.get(productoId) ?? { productoId, nombre, vendidas: 0, cortesias: 0, merma: 0 };
    stock.merma += cantidad;
    inventario.set(productoId, stock);
  };

  for (const venta of input.ventas) {
    venta.warnings?.forEach((warning) => warnings.add(warning));

    if (venta.soloInventario) {
      const wasteLines = (venta.inventarioLineas?.length ? venta.inventarioLineas : venta.lineas);
      wasteLines.forEach(addMerma);
      continue;
    }

    const bruto = amount(venta.importeBruto);
    const efectivo = amount(venta.efectivo);
    const tarjeta = amount(venta.tarjeta);
    const puntos = amount(venta.valorPuntos);
    const descuentoPromo = amount(venta.descuentoPromocion);
    const descuentoAbon = amount(venta.descuentoAbonado);
    const totalPagado = roundMoney(efectivo + tarjeta + puntos);
    ventasBrutas = roundMoney(ventasBrutas + bruto);
    descuentosPromocion = roundMoney(descuentosPromocion + descuentoPromo);
    descuentosAbonado = roundMoney(descuentosAbonado + descuentoAbon);
    efectivoBruto = roundMoney(efectivoBruto + efectivo);
    tarjetaBruta = roundMoney(tarjetaBruta + tarjeta);
    puntosBrutos = roundMoney(puntosBrutos + puntos);
    puntosCantidad += quantity(venta.cantidadPuntos);

    const partialRefundComplete = venta.estatus !== "REEMBOLSADA_PARCIAL" || (
      venta.reembolso != null && [
        venta.reembolso.efectivo,
        venta.reembolso.tarjeta,
        venta.reembolso.valorPuntos,
        venta.reembolso.cantidadPuntos,
      ].every(isNonnegativeNumber)
    );
    const invalidPartialRefund = venta.estatus === "REEMBOLSADA_PARCIAL" && !partialRefundComplete;
    if (invalidPartialRefund) {
      incidencias.push({ codigo: "PARTIAL_REFUND_SPLIT_REQUIRED", ventaId: venta.id, bloqueante: true });
    }
    const fullReversal = venta.estatus === "CANCELADA" || venta.estatus === "REEMBOLSADA" || invalidPartialRefund;
    const refund = venta.estatus === "REEMBOLSADA" || invalidPartialRefund
      ? { efectivo, tarjeta, valorPuntos: puntos, cantidadPuntos: quantity(venta.cantidadPuntos) }
      : venta.estatus === "REEMBOLSADA_PARCIAL"
        ? {
            efectivo: Math.min(efectivo, amount(venta.reembolso?.efectivo)),
            tarjeta: Math.min(tarjeta, amount(venta.reembolso?.tarjeta)),
            valorPuntos: Math.min(puntos, amount(venta.reembolso?.valorPuntos)),
            cantidadPuntos: Math.min(quantity(venta.cantidadPuntos), quantity(venta.reembolso?.cantidadPuntos)),
          }
        : { efectivo: 0, tarjeta: 0, valorPuntos: 0, cantidadPuntos: 0 };

    if (venta.estatus === "CANCELADA") {
      cancelaciones = roundMoney(cancelaciones + totalPagado);
      efectivoRevertido = roundMoney(efectivoRevertido + efectivo);
      tarjetaRevertida = roundMoney(tarjetaRevertida + tarjeta);
      puntosRevertidos = roundMoney(puntosRevertidos + puntos);
      puntosCantidadRevertida += quantity(venta.cantidadPuntos);
    } else if (venta.estatus === "REEMBOLSADA" || venta.estatus === "REEMBOLSADA_PARCIAL") {
      const totalRefund = roundMoney(refund.efectivo + refund.tarjeta + refund.valorPuntos);
      reembolsos = roundMoney(reembolsos + totalRefund);
      efectivoRevertido = roundMoney(efectivoRevertido + refund.efectivo);
      tarjetaRevertida = roundMoney(tarjetaRevertida + refund.tarjeta);
      puntosRevertidos = roundMoney(puntosRevertidos + refund.valorPuntos);
      puntosCantidadRevertida += refund.cantidadPuntos;
    }

    if (fullReversal) continue;

    const netCash = roundMoney(efectivo - refund.efectivo);
    const netCard = roundMoney(tarjeta - refund.tarjeta);
    const netPoints = roundMoney(puntos - refund.valorPuntos);
    const ventaNeta = roundMoney(bruto - descuentoPromo - descuentoAbon - refund.efectivo - refund.tarjeta - refund.valorPuntos);
    cantidadTickets += 1;
    cantidadUnidades += quantity(venta.unidades);
    if (netPoints > 0) ventasConPuntos += 1;
    if (venta.abonado) {
      abonados.operaciones += 1;
      abonados.unidades += quantity(venta.unidades);
      abonados.importeCobrado = roundMoney(abonados.importeCobrado + netCash + netCard + netPoints);
      abonados.descuentoOtorgado = roundMoney(abonados.descuentoOtorgado + descuentoAbon);
    }

    for (const promo of venta.promociones ?? []) {
      const previous = promociones.get(promo.id);
      promociones.set(promo.id, {
        id: promo.id,
        nombre: promo.nombre,
        montoTotal: roundMoney((previous?.montoTotal ?? 0) + amount(promo.montoTotal)),
        montoDescuento: roundMoney((previous?.montoDescuento ?? 0) + amount(promo.montoDescuento)),
        unidadesGratis: (previous?.unidadesGratis ?? 0) + quantity(promo.unidadesGratis),
        cantidadTransacciones: (previous?.cantidadTransacciones ?? 0) + 1,
      });
    }

    venta.lineas.forEach((linea, index) => {
      const cantidad = quantity(linea.cantidad);
      const precio = amount(linea.precioUnitario);
      const subtotal = lineSubtotal(linea);
      const zeroPrice = isNonnegativeNumber(linea.precioUnitario) && precio === 0;
      const legacyFallback = zeroPrice && venta.calculationVersion === LEGACY_CALCULATION_VERSION;
      const courtesy = linea.esCortesia === true || legacyFallback;

      if (linea.esMerma) {
        addMerma(linea);
        return;
      }
      if (courtesy) {
        cortesias.cantidad += cantidad;
        cortesias.valorTeorico = roundMoney(cortesias.valorTeorico + cantidad * amount(linea.precioReferencia));
        if (legacyFallback && linea.esCortesia !== true) warnings.add("LEGACY_ZERO_PRICE_AS_COURTESY");
      } else if (zeroPrice) {
        incidencias.push({ codigo: "UNCLASSIFIED_ZERO_PRICE", ventaId: venta.id, linea: index });
      }

      if (linea.comboId) {
        const previous = combos.get(linea.comboId);
        combos.set(linea.comboId, {
          comboId: linea.comboId,
          nombre: linea.nombre ?? previous?.nombre ?? "Combo",
          cantidadVendidos: (previous?.cantidadVendidos ?? 0) + cantidad,
          montoTotal: roundMoney((previous?.montoTotal ?? 0) + subtotal),
        });
      }

      if (!linea.productoId) return;
      const nombre = linea.nombre ?? "Producto";
      const priceKey = `${linea.productoId}|${precio}`;
      const previousPrice = productos.get(priceKey);
      productos.set(priceKey, {
        productoId: linea.productoId,
        nombre,
        cantidad: (previousPrice?.cantidad ?? 0) + cantidad,
        subtotal: roundMoney((previousPrice?.subtotal ?? 0) + subtotal),
        precioUnitario: precio,
      });

      const report = productoReporte.get(linea.productoId) ?? {
        productoId: linea.productoId,
        nombre,
        cantidadRegular: 0,
        cantidadAbonado: 0,
        ventasRegular: 0,
        ventasAbonado: 0,
        cortesias: 0,
        puntosCanjeados: 0,
        ventasTotales: 0,
      };
      if (courtesy) {
        report.cortesias += cantidad;
      } else if (venta.abonado) {
        report.cantidadAbonado += cantidad;
        report.ventasAbonado = roundMoney(report.ventasAbonado + subtotal);
      } else {
        report.cantidadRegular += cantidad;
        report.ventasRegular = roundMoney(report.ventasRegular + subtotal);
      }
      report.ventasTotales = roundMoney(report.ventasTotales + subtotal);
      if (totalPagado > 0 && netPoints > 0) {
        report.puntosCanjeados = roundMoney(report.puntosCanjeados + (subtotal / totalPagado) * netPoints);
      }
      productoReporte.set(linea.productoId, report);
    });

    const inventoryLines = venta.inventarioLineas?.length ? venta.inventarioLineas : venta.lineas;
    for (const linea of inventoryLines) {
      if (!linea.productoId) continue;
      if (linea.esMerma) {
        addMerma(linea);
        continue;
      }
      const cantidad = quantity(linea.cantidad);
      const stock = inventario.get(linea.productoId) ?? {
        productoId: linea.productoId,
        nombre: linea.nombre ?? "Producto",
        vendidas: 0,
        cortesias: 0,
        merma: 0,
      };
      if (linea.esCortesia) stock.cortesias += cantidad;
      else stock.vendidas += cantidad;
      inventario.set(linea.productoId, stock);
    }

    if (venta.hora) {
      const hourly = ventasPorHora.get(venta.hora) ?? { hora: venta.hora, ventasNetas: 0, dineroReal: 0, tickets: 0 };
      hourly.ventasNetas = roundMoney(hourly.ventasNetas + ventaNeta);
      hourly.dineroReal = roundMoney(hourly.dineroReal + netCash + netCard);
      hourly.tickets += 1;
      ventasPorHora.set(venta.hora, hourly);
    }
  }

  const efectivoNeto = roundMoney(efectivoBruto - efectivoRevertido);
  const tarjetaNeta = roundMoney(tarjetaBruta - tarjetaRevertida);
  const valorPuntosCanjeados = roundMoney(puntosBrutos - puntosRevertidos);
  const dineroReal = roundMoney(efectivoNeto + tarjetaNeta);
  const ventasNetas = roundMoney(ventasBrutas - descuentosPromocion - descuentosAbonado - cancelaciones - reembolsos);
  const movimientos = { entradas: 0, salidas: 0, retiros: 0, depositos: 0, devolucionesEfectivo: 0, ajustes: 0 };
  for (const movimiento of input.movimientosCaja ?? []) {
    const monto = movimiento.tipo === "AJUSTE_AUTORIZADO" ? roundMoney(movimiento.monto) : amount(movimiento.monto);
    if (movimiento.tipo === "ENTRADA") movimientos.entradas += monto;
    else if (movimiento.tipo === "SALIDA") movimientos.salidas += monto;
    else if (movimiento.tipo === "RETIRO") movimientos.retiros += monto;
    else if (movimiento.tipo === "DEPOSITO") movimientos.depositos += monto;
    else if (movimiento.tipo === "DEVOLUCION_EFECTIVO") movimientos.devolucionesEfectivo += monto;
    else movimientos.ajustes += monto;
  }
  const fondoInicial = amount(input.fondoInicial);
  const efectivoEsperado = roundMoney(fondoInicial + efectivoNeto + movimientos.entradas - movimientos.salidas - movimientos.retiros - movimientos.depositos - movimientos.devolucionesEfectivo + movimientos.ajustes);
  const efectivoContado = input.efectivoContado == null ? null : amount(input.efectivoContado);
  const porcentajeAplicado = Math.min(100, amount(input.porcentajeComision));
  const baseComision = dineroReal;
  const promotionItems = Array.from(promociones.values()).sort((a, b) => b.montoDescuento - a.montoDescuento);
  const comboItems = Array.from(combos.values()).sort((a, b) => b.montoTotal - a.montoTotal);
  const inventoryItems = Array.from(inventario.values()).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  return {
    calculationVersion: CALCULATION_VERSION,
    finanzas: {
      ventasBrutas, descuentosPromocion, descuentosAbonado, cancelaciones, reembolsos, ventasNetas,
      efectivoBruto, efectivoNeto, tarjetaBruta, tarjetaNeta, dineroReal,
      valorPuntosCanjeados, cantidadPuntosCanjeados: puntosCantidad - puntosCantidadRevertida,
      cantidadVentasConPuntos: ventasConPuntos, cantidadTickets, cantidadUnidades,
      ticketPromedio: cantidadTickets > 0 ? roundMoney(ventasNetas / cantidadTickets) : 0,
    },
    abonados,
    cortesias,
    promociones: {
      montoTotal: roundMoney(promotionItems.reduce((sum, item) => sum + item.montoTotal, 0)),
      montoDescuento: roundMoney(promotionItems.reduce((sum, item) => sum + item.montoDescuento, 0)),
      unidadesGratis: promotionItems.reduce((sum, item) => sum + item.unidadesGratis, 0),
      cantidadTransacciones: promotionItems.reduce((sum, item) => sum + item.cantidadTransacciones, 0),
      items: promotionItems,
    },
    combos: {
      montoTotal: roundMoney(comboItems.reduce((sum, item) => sum + item.montoTotal, 0)),
      cantidadVendidos: comboItems.reduce((sum, item) => sum + item.cantidadVendidos, 0),
      items: comboItems,
    },
    merma,
    productos: Array.from(productos.values()).sort((a, b) => b.subtotal - a.subtotal),
    productoReporte: Array.from(productoReporte.values()),
    inventario: {
      unidadesVendidas: inventoryItems.reduce((sum, item) => sum + item.vendidas, 0),
      unidadesCortesia: inventoryItems.reduce((sum, item) => sum + item.cortesias, 0),
      unidadesMerma: inventoryItems.reduce((sum, item) => sum + item.merma, 0),
      items: inventoryItems,
    },
    metodosPago: { efectivo: efectivoNeto, tarjeta: tarjetaNeta, puntos: valorPuntosCanjeados },
    ventasPorHora: Array.from(ventasPorHora.values()).sort((a, b) => a.hora.localeCompare(b.hora)),
    caja: {
      fondoInicial, ...movimientos, efectivoEsperado, efectivoContado,
      diferenciaCaja: efectivoContado == null ? null : roundMoney(efectivoContado - efectivoEsperado),
    },
    comision: {
      porcentajeAplicado, baseComision,
      importeComision: roundCommission(baseComision, porcentajeAplicado),
      reglaRedondeo: "HALF_UP_CENTS" as const,
    },
    warnings: Array.from(warnings),
    incidencias,
  };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const statusFrom = (value: unknown, warnings: string[]): EstatusVenta => {
  const status = String(value ?? "VALIDA").toUpperCase();
  if (["CANCELADA", "CANCELLED", "ANULADA"].includes(status)) return "CANCELADA";
  if (["REEMBOLSADA", "REFUNDED", "DEVUELTA"].includes(status)) return "REEMBOLSADA";
  if (["REEMBOLSADA_PARCIAL", "PARTIALLY_REFUNDED"].includes(status)) return "REEMBOLSADA_PARCIAL";
  if (!["VALIDA", "VALID", "COMPLETADA", "PAGADA"].includes(status)) warnings.push("UNKNOWN_SALE_STATUS_DEFAULTED");
  return "VALIDA";
};

const stringValue = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const normalizeLine = (raw: unknown): LineaVentaNormalizada => {
  const line = record(raw);
  const tipo = String(line.tipo ?? "").toUpperCase();
  const cantidad = quantity(line.cantidad);
  const precioUnitarioRaw = line.precio_actual ?? line.precioUnitario ?? line.precio;
  const precioReferenciaRaw = line.precioReferencia ?? line.precio_lista ?? line.precioOriginal;
  return {
    ...(stringValue(line.producto, line.productoId, line.producto_id) ? { productoId: stringValue(line.producto, line.productoId, line.producto_id) } : {}),
    ...(stringValue(line.combo, line.comboId, line.combo_id) ? { comboId: stringValue(line.combo, line.comboId, line.combo_id) } : {}),
    ...(stringValue(line.nombre, line.titulo, line.productoNombre, line.comboNombre) ? { nombre: stringValue(line.nombre, line.titulo, line.productoNombre, line.comboNombre) } : {}),
    cantidad,
    ...(isNonnegativeNumber(precioUnitarioRaw) ? { precioUnitario: amount(precioUnitarioRaw) } : {}),
    ...(isNonnegativeNumber(precioReferenciaRaw) ? { precioReferencia: amount(precioReferenciaRaw) } : {}),
    ...(isNonnegativeNumber(line.subtotal) ? { subtotal: amount(line.subtotal) } : {}),
    ...(line.esCortesia === true || line.cortesia === true || tipo === "CORTESIA" ? { esCortesia: true } : {}),
    ...(line.esMerma === true || line.merma === true || tipo === "MERMA" ? { esMerma: true } : {}),
  };
};

const timestampHour = (value: unknown): string | null => {
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  } else {
    const data = record(value);
    if (typeof data.toDate === "function") {
      const parsed = (data.toDate as () => unknown)();
      if (parsed instanceof Date) date = parsed;
    } else if (typeof data._seconds === "number") {
      date = new Date(data._seconds * 1000);
    } else if (typeof data.seconds === "number") {
      date = new Date(data.seconds * 1000);
    }
  }
  return date && !Number.isNaN(date.getTime()) ? `${String(date.getHours()).padStart(2, "0")}:00` : null;
};

const normalizePromotions = (
  source: Readonly<Record<string, unknown>>,
  abonado: Record<string, unknown>,
): { promociones: PromocionNormalizada[]; descuentoExplicito: number } => {
  const rawPromotions = Array.isArray(source.promociones)
    ? source.promociones
    : Object.keys(record(source.promocion)).length > 0
      ? [source.promocion]
      : [];
  const explicit = rawPromotions.map((raw, index) => {
    const promotion = record(raw);
    return {
      id: stringValue(promotion.id, promotion.promocionId, promotion.benefitId) ?? `promocion-${index + 1}`,
      nombre: stringValue(promotion.nombre, promotion.titulo) ?? "Promocion",
      montoTotal: amount(promotion.montoTotal ?? source.total),
      montoDescuento: amount(promotion.montoDescuento ?? promotion.descuento),
      unidadesGratis: quantity(promotion.unidadesGratis),
    };
  });
  if (explicit.length > 0) {
    return {
      promociones: explicit,
      descuentoExplicito: explicit.reduce((sum, item) => roundMoney(sum + item.montoDescuento), 0),
    };
  }
  if (amount(abonado.montoDescuento) > 0 || quantity(abonado.unidadesGratis) > 0) {
    return {
      promociones: [{
        id: stringValue(abonado.benefitId) ?? "beneficio-abonado",
        nombre: stringValue(abonado.titulo) ?? "Beneficio abonado",
        montoTotal: amount(abonado.montoTotal ?? source.total),
        montoDescuento: amount(abonado.montoDescuento),
        unidadesGratis: quantity(abonado.unidadesGratis),
      }],
      descuentoExplicito: 0,
    };
  }
  return { promociones: [], descuentoExplicito: 0 };
};

/** Adapts persisted comprobantes without mutating or changing any legacy field. */
export const normalizarComprobanteLegacy = (source: Readonly<Record<string, unknown>>): VentaNormalizada => {
  const warnings: string[] = [];
  const total = amount(source.total);
  const explicitAmounts = [source.montoEfectivo, source.montoTarjeta, source.montoPuntos]
    .some((value) => amount(value) > 0);
  const metodo = String(source.metodoPago ?? "efectivo").toLowerCase();
  const abonado = record(source.abonado);
  const descuentoAbonado = amount(abonado.montoDescuento);
  const promotionData = normalizePromotions(source, abonado);
  const descuentoPromocion = amount(source.descuentoPromocion ?? promotionData.descuentoExplicito);
  const montoTotalAbonado = amount(abonado.montoTotal);
  const maxPromotionTotal = promotionData.promociones.reduce((max, item) => Math.max(max, item.montoTotal), 0);
  const saleLines = Array.isArray(source.lineasVenta) ? source.lineasVenta : [];
  const detailLines = Array.isArray(source.detalle) ? source.detalle : [];
  const saleLinesHavePrices = saleLines.length > 0 && saleLines
    .every((raw) => isNonnegativeNumber(record(raw).precio_actual ?? record(raw).precioUnitario ?? record(raw).precio));
  const rawLines = saleLines.length > 0 && (saleLinesHavePrices || detailLines.length === 0)
    ? saleLines
    : detailLines;
  const lineas = rawLines.map(normalizeLine);
  const inventarioLineas = (detailLines.length > 0 ? detailLines : rawLines).map(normalizeLine);
  const refund = record(source.reembolso);
  const refundFields = {
    efectivo: refund.efectivo ?? source.montoReembolsadoEfectivo,
    tarjeta: refund.tarjeta ?? source.montoReembolsadoTarjeta,
    valorPuntos: refund.valorPuntos ?? source.montoReembolsadoPuntos,
    cantidadPuntos: refund.cantidadPuntos,
  };
  const hasRefundData = Object.values(refundFields).some(isNonnegativeNumber);
  const calculationVersion = typeof source.calculationVersion === "string" && source.calculationVersion
    ? source.calculationVersion
    : LEGACY_CALCULATION_VERSION;
  const movementType = String(source.tipo ?? source.naturaleza ?? source.operacion ?? "").toUpperCase();
  const soloInventario = source.esMerma === true || movementType === "MERMA";

  return {
    id: typeof source.id === "string" ? source.id : undefined,
    calculationVersion,
    estatus: statusFrom(source.estatus ?? source.estado ?? source.status, warnings),
    importeBruto: soloInventario ? 0 : Math.max(total + descuentoAbonado + descuentoPromocion, montoTotalAbonado, maxPromotionTotal),
    efectivo: soloInventario ? 0 : explicitAmounts ? amount(source.montoEfectivo) : metodo === "tarjeta" || metodo === "puntos" ? 0 : total,
    tarjeta: soloInventario ? 0 : explicitAmounts ? amount(source.montoTarjeta) : metodo === "tarjeta" ? total : 0,
    valorPuntos: soloInventario ? 0 : explicitAmounts ? amount(source.montoPuntos) : metodo === "puntos" ? total : 0,
    cantidadPuntos: soloInventario ? 0 : quantity(source.puntosUsados),
    descuentoPromocion: soloInventario ? 0 : descuentoPromocion,
    descuentoAbonado: soloInventario ? 0 : descuentoAbonado,
    unidades: soloInventario ? 0 : lineas.reduce((sum, line) => sum + line.cantidad, 0),
    abonado: !soloInventario && (descuentoAbonado > 0 || quantity(abonado.unidadesGratis) > 0),
    lineas,
    inventarioLineas,
    promociones: promotionData.promociones,
    hora: timestampHour(source.fecha ?? source.createdAt),
    soloInventario,
    ...(hasRefundData ? { reembolso: {
      ...(isNonnegativeNumber(refundFields.efectivo) ? { efectivo: amount(refundFields.efectivo) } : {}),
      ...(isNonnegativeNumber(refundFields.tarjeta) ? { tarjeta: amount(refundFields.tarjeta) } : {}),
      ...(isNonnegativeNumber(refundFields.valorPuntos) ? { valorPuntos: amount(refundFields.valorPuntos) } : {}),
      ...(isNonnegativeNumber(refundFields.cantidadPuntos) ? { cantidadPuntos: quantity(refundFields.cantidadPuntos) } : {}),
    } } : {}),
    warnings,
  };
};

/** The single persisted-receipt adapter + calculation entry point used by cortes APIs. */
export const calcularComprobantes = (
  comprobantes: readonly Readonly<Record<string, unknown>>[],
  options: CalcularComprobantesOptions = {},
) => {
  const ventas = comprobantes.map((source) => {
    const normalized = normalizarComprobanteLegacy(source);
    const withNames = (line: LineaVentaNormalizada): LineaVentaNormalizada => ({
      ...line,
      nombre: line.productoId
        ? options.productNames?.get(line.productoId) ?? line.nombre
        : line.comboId
          ? options.comboNames?.get(line.comboId) ?? line.nombre
          : line.nombre,
    });
    return {
      ...normalized,
      lineas: normalized.lineas.map(withNames),
      inventarioLineas: normalized.inventarioLineas?.map(withNames),
    };
  });
  return calcularCorte({
    ventas,
    fondoInicial: options.fondoInicial,
    movimientosCaja: options.movimientosCaja,
    efectivoContado: options.efectivoContado,
    porcentajeComision: options.porcentajeComision,
  });
};

export type CorteCalculationResult = ReturnType<typeof calcularCorte>;

export const crearSnapshotCorte = (
  calculation: CorteCalculationResult,
  metadata: {
    generatedAt: unknown;
    businessDate: string;
    jornadaId: string | null;
    sesionCajaId?: string | null;
    conteoComprobantes: number;
  },
) => ({
  calculationVersion: CALCULATION_VERSION,
  generatedAt: metadata.generatedAt,
  businessDate: metadata.businessDate,
  jornadaId: metadata.jornadaId,
  sesionCajaId: metadata.sesionCajaId ?? null,
  totalesSnapshot: calculation.finanzas,
  metodosPagoSnapshot: calculation.metodosPago,
  productosSnapshot: calculation.productos,
  inventarioSnapshot: calculation.inventario,
  comisionSnapshot: calculation.comision,
  puntosSnapshot: {
    valorPuntosCanjeados: calculation.finanzas.valorPuntosCanjeados,
    cantidadPuntosCanjeados: calculation.finanzas.cantidadPuntosCanjeados,
    cantidadVentasConPuntos: calculation.finanzas.cantidadVentasConPuntos,
  },
  abonadosSnapshot: calculation.abonados,
  cortesiasSnapshot: calculation.cortesias,
  mermaSnapshot: calculation.merma,
  promocionesSnapshot: calculation.promociones,
  combosSnapshot: calculation.combos,
  conteoComprobantes: Math.max(0, Math.trunc(metadata.conteoComprobantes)),
});

const numeric = (value: unknown, fallback = 0): number => {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Additive historical adapter. Snapshot fields win when available; legacy
 * scalar properties remain readable and are never rewritten.
 */
export const adaptarCortePersistido = (source: Readonly<Record<string, unknown>>) => {
  const totals = record(source.totalesSnapshot);
  const payments = record(source.metodosPagoSnapshot);
  const points = record(source.puntosSnapshot);
  const commission = record(source.comisionSnapshot);
  const hasSnapshot = Object.keys(totals).length > 0;
  const efectivoNeto = numeric(
    totals.efectivoNeto,
    numeric(payments.efectivo, numeric(source.totalEfectivo, numeric(source.totalCaja))),
  );
  const tarjetaNeta = numeric(
    totals.tarjetaNeta,
    numeric(payments.tarjeta, numeric(source.totalTarjeta)),
  );
  const dineroReal = numeric(totals.dineroReal, numeric(source.totalReal, efectivoNeto + tarjetaNeta));
  const valorPuntosCanjeados = numeric(
    totals.valorPuntosCanjeados,
    numeric(points.valorPuntosCanjeados, numeric(payments.puntos, numeric(source.totalPuntosMonto))),
  );
  const cantidadPuntosCanjeados = numeric(
    totals.cantidadPuntosCanjeados,
    numeric(points.cantidadPuntosCanjeados, numeric(source.totalPuntosCanjeados)),
  );
  const cantidadTickets = numeric(
    totals.cantidadTickets,
    numeric(source.conteoComprobantes, numeric(source.cantidadVentas)),
  );
  const ventasNetas = numeric(totals.ventasNetas, dineroReal);
  const inventarioSnapshot = record(source.inventarioSnapshot);

  return {
    calculationVersion: hasSnapshot
      ? String(source.calculationVersion ?? CALCULATION_VERSION)
      : String(source.calculationVersion ?? LEGACY_CALCULATION_VERSION),
    generatedAt: source.generatedAt ?? source.createdAt ?? null,
    businessDate: source.businessDate ?? source.fecha ?? null,
    sesionCajaId: source.sesionCajaId ?? null,
    conteoComprobantes: numeric(source.conteoComprobantes, cantidadTickets),
    finanzas: {
      ventasBrutas: numeric(totals.ventasBrutas, ventasNetas),
      descuentosPromocion: numeric(totals.descuentosPromocion),
      descuentosAbonado: numeric(totals.descuentosAbonado),
      cancelaciones: numeric(totals.cancelaciones),
      reembolsos: numeric(totals.reembolsos),
      ventasNetas,
      efectivoBruto: numeric(totals.efectivoBruto, efectivoNeto),
      efectivoNeto,
      tarjetaBruta: numeric(totals.tarjetaBruta, tarjetaNeta),
      tarjetaNeta,
      dineroReal,
      valorPuntosCanjeados,
      cantidadPuntosCanjeados,
      cantidadVentasConPuntos: numeric(
        totals.cantidadVentasConPuntos,
        numeric(points.cantidadVentasConPuntos, numeric(source.ventasConPuntos)),
      ),
      cantidadTickets,
      cantidadUnidades: numeric(totals.cantidadUnidades),
      ticketPromedio: numeric(
        totals.ticketPromedio,
        cantidadTickets > 0 ? roundMoney(ventasNetas / cantidadTickets) : 0,
      ),
    },
    metodosPago: { efectivo: efectivoNeto, tarjeta: tarjetaNeta, puntos: valorPuntosCanjeados },
    productos: Array.isArray(source.productosSnapshot)
      ? source.productosSnapshot
      : Array.isArray(source.productos)
        ? source.productos
        : [],
    inventario: Object.keys(inventarioSnapshot).length > 0
      ? inventarioSnapshot
      : { unidadesVendidas: 0, unidadesCortesia: 0, unidadesMerma: 0, items: [] },
    comision: Object.keys(commission).length > 0
      ? commission
      : { porcentajeAplicado: 0, baseComision: dineroReal, importeComision: 0, reglaRedondeo: "HALF_UP_CENTS" },
    puntos: Object.keys(points).length > 0
      ? points
      : { valorPuntosCanjeados, cantidadPuntosCanjeados, cantidadVentasConPuntos: numeric(source.ventasConPuntos) },
    abonados: record(source.abonadosSnapshot),
    cortesias: record(source.cortesiasSnapshot),
    merma: record(source.mermaSnapshot),
    promociones: Object.keys(record(source.promocionesSnapshot)).length > 0
      ? record(source.promocionesSnapshot)
      : record(source.promociones2x1),
    combos: Object.keys(record(source.combosSnapshot)).length > 0
      ? record(source.combosSnapshot)
      : record(source.combos),
    caja: {
      efectivoContado: source.efectivoContado == null ? null : numeric(source.efectivoContado),
      diferenciaCaja: source.diferenciaCaja == null ? null : numeric(source.diferenciaCaja),
    },
  };
};
