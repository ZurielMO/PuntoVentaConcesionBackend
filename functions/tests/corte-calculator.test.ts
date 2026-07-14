import {
  CALCULATION_VERSION,
  LEGACY_CALCULATION_VERSION,
  calcularCorte,
  calcularComprobantes,
  adaptarCortePersistido,
  crearSnapshotCorte,
  normalizarComprobanteLegacy,
  type VentaNormalizada,
} from "../src/domain/cortes/corte-calculator";

const venta = (overrides: Partial<VentaNormalizada> = {}): VentaNormalizada => ({
  id: "v-1",
  calculationVersion: CALCULATION_VERSION,
  estatus: "VALIDA",
  importeBruto: 100,
  efectivo: 100,
  tarjeta: 0,
  valorPuntos: 0,
  cantidadPuntos: 0,
  descuentoPromocion: 0,
  descuentoAbonado: 0,
  unidades: 1,
  lineas: [{ cantidad: 1, precioUnitario: 100 }],
  ...overrides,
});

describe("calcularCorte", () => {
  it.each([
    ["cash", { efectivo: 100 }, [100, 0, 0, 100]],
    ["card", { efectivo: 0, tarjeta: 100 }, [0, 100, 0, 100]],
    ["mixed", { efectivo: 40, tarjeta: 60 }, [40, 60, 0, 100]],
    ["points", { efectivo: 60, valorPuntos: 40, cantidadPuntos: 400 }, [60, 0, 40, 60]],
  ])("separates %s payments", (_name, overrides, expected) => {
    const result = calcularCorte({ ventas: [venta(overrides)] });
    expect([
      result.finanzas.efectivoNeto,
      result.finanzas.tarjetaNeta,
      result.finanzas.valorPuntosCanjeados,
      result.finanzas.dineroReal,
    ]).toEqual(expected);
  });

  it("treats subscriber status as a benefit, never as payment", () => {
    const result = calcularCorte({
      ventas: [venta({ importeBruto: 120, efectivo: 100, descuentoAbonado: 20, abonado: true, unidades: 2 })],
    });
    expect(result.abonados).toEqual({ operaciones: 1, unidades: 2, importeCobrado: 100, descuentoOtorgado: 20 });
    expect(result.finanzas).toMatchObject({ ventasBrutas: 120, descuentosAbonado: 20, ventasNetas: 100, efectivoNeto: 100, cantidadTickets: 1, cantidadUnidades: 2, ticketPromedio: 100 });
  });

  it.each([
    ["explicit", CALCULATION_VERSION, true, 2, 100, undefined],
    ["legacy zero", LEGACY_CALCULATION_VERSION, false, 2, 100, "LEGACY_ZERO_PRICE_AS_COURTESY"],
  ])("counts %s courtesy without income", (_name, version, explicit, quantity, value, warning) => {
    const result = calcularCorte({ ventas: [venta({
      calculationVersion: version,
      importeBruto: 0,
      efectivo: 0,
      unidades: quantity,
      lineas: [{ cantidad: quantity, precioUnitario: 0, precioReferencia: 50, esCortesia: explicit }],
    })] });
    expect(result.cortesias).toEqual({ cantidad: quantity, valorTeorico: value });
    expect(result.finanzas.dineroReal).toBe(0);
    if (warning) expect(result.warnings).toContain(warning);
  });

  it("reports a new zero-price line without classification", () => {
    const result = calcularCorte({ ventas: [venta({ importeBruto: 0, efectivo: 0, lineas: [{ cantidad: 1, precioUnitario: 0 }] })] });
    expect(result.cortesias.cantidad).toBe(0);
    expect(result.incidencias).toContainEqual({ codigo: "UNCLASSIFIED_ZERO_PRICE", ventaId: "v-1", linea: 0 });
  });

  it.each([
    ["cancelled", { estatus: "CANCELADA" as const }, [100, 0, 0]],
    ["fully refunded", { estatus: "REEMBOLSADA" as const }, [0, 100, 0]],
    ["partially refunded", { estatus: "REEMBOLSADA_PARCIAL" as const, reembolso: { efectivo: 25, tarjeta: 0, valorPuntos: 0, cantidadPuntos: 0 } }, [0, 25, 75]],
  ])("applies %s financial effect", (_name, overrides, expected) => {
    const result = calcularCorte({ ventas: [venta(overrides)] });
    expect([result.finanzas.cancelaciones, result.finanzas.reembolsos, result.finanzas.ventasNetas]).toEqual(expected);
  });

  it.each([
    ["absent", undefined],
    ["incomplete", { efectivo: 25 } as VentaNormalizada["reembolso"]],
  ])("fails closed when a partial refund split is %s", (_name, reembolso) => {
    const result = calcularCorte({ ventas: [venta({ estatus: "REEMBOLSADA_PARCIAL", reembolso })] });
    expect(result.finanzas).toMatchObject({ reembolsos: 100, ventasNetas: 0, cantidadTickets: 0 });
    expect(result.incidencias).toContainEqual({ codigo: "PARTIAL_REFUND_SPLIT_REQUIRED", ventaId: "v-1", bloqueante: true });
  });

  it("calculates expected cash from fund, sales and cash movements", () => {
    const result = calcularCorte({
      ventas: [venta()],
      fondoInicial: 50,
      movimientosCaja: [
        { tipo: "ENTRADA", monto: 20 },
        { tipo: "SALIDA", monto: 5 },
        { tipo: "RETIRO", monto: 10 },
        { tipo: "DEVOLUCION_EFECTIVO", monto: 15 },
      ],
      efectivoContado: 145,
    });
    expect(result.caja).toMatchObject({ efectivoEsperado: 140, efectivoContado: 145, diferenciaCaja: 5 });
    expect(calcularCorte({ ventas: [venta()], efectivoContado: 95 }).caja.diferenciaCaja).toBe(-5);
  });

  it.each([
    [10.05, 10, 1.01],
    [2.26, 75, 1.7],
    [100.75, 10, 10.08],
  ])("uses real money as commission base and rounds %s at %s%% half-up to cents", (base, rate, expected) => {
    const result = calcularCorte({ ventas: [venta({ importeBruto: base, efectivo: base, lineas: [] })], porcentajeComision: rate });
    expect(result.comision).toEqual({ porcentajeAplicado: rate, baseComision: base, importeComision: expected, reglaRedondeo: "HALF_UP_CENTS" });
  });

  it("aggregates promotions and combos without counting expanded components as income", () => {
    const result = calcularComprobantes([
      {
        id: "combo-sale",
        total: 180,
        metodoPago: "tarjeta",
        lineasVenta: [
          { combo: "combo-1", nombre: "Combo Familiar", cantidad: 1, precio_actual: 120 },
          { producto: "p-3", nombre: "Refresco", cantidad: 1, precio_actual: 60 },
        ],
        detalle: [
          { producto: "p-1", cantidad: 2, precio_actual: 40, subtotal: 80 },
          { producto: "p-2", cantidad: 1, precio_actual: 40, subtotal: 40 },
          { producto: "p-3", cantidad: 1, precio_actual: 60, subtotal: 60 },
        ],
        promocion: {
          id: "promo-1",
          titulo: "Precio especial",
          montoTotal: 200,
          montoDescuento: 20,
          unidadesGratis: 0,
        },
      },
    ]);

    expect(result.finanzas).toMatchObject({ ventasBrutas: 200, descuentosPromocion: 20, ventasNetas: 180, dineroReal: 180 });
    expect(result.combos).toMatchObject({ montoTotal: 120, cantidadVendidos: 1 });
    expect(result.promociones).toMatchObject({ montoTotal: 200, montoDescuento: 20, cantidadTransacciones: 1 });
    expect(result.productos.reduce((sum, item) => sum + item.subtotal, 0)).toBe(60);
    expect(result.inventario.unidadesVendidas).toBe(4);
  });

  it("keeps waste as inventory-only and does not turn it into sales", () => {
    const result = calcularComprobantes([
      {
        id: "waste-1",
        tipo: "MERMA",
        total: 90,
        metodoPago: "efectivo",
        lineasVenta: [
          { producto: "p-1", nombre: "Producto", cantidad: 2, precio_actual: 45, esMerma: true },
        ],
      },
    ]);

    expect(result.finanzas).toMatchObject({ ventasBrutas: 0, ventasNetas: 0, dineroReal: 0, cantidadTickets: 0 });
    expect(result.merma).toMatchObject({ cantidad: 2, valorTeorico: 90 });
    expect(result.inventario).toMatchObject({ unidadesVendidas: 0, unidadesMerma: 2 });
  });
});

describe("normalizarComprobanteLegacy", () => {
  it("defaults version/status, preserves legacy field types and does not mutate input", () => {
    const input = Object.freeze({
      id: "legacy-1",
      total: 90,
      metodoPago: "efectivo",
      abonado: Object.freeze({ montoTotal: 100, montoDescuento: 10, unidadesGratis: 1 }),
      detalle: Object.freeze([Object.freeze({ producto: "p-1", cantidad: 2, precio_actual: 45 })]),
    });
    const before = JSON.stringify(input);
    const normalized = normalizarComprobanteLegacy(input);
    expect(normalized).toMatchObject({ calculationVersion: "legacy-v1", estatus: "VALIDA", importeBruto: 100, efectivo: 90, descuentoAbonado: 10, abonado: true, unidades: 2 });
    expect(JSON.stringify(input)).toBe(before);
    expect(normalized.lineas).not.toBe(input.detalle);
  });

  it("falls back to legacy payment data when only a zero points split is present", () => {
    const fallback = normalizarComprobanteLegacy({ total: 90, metodoPago: "efectivo", montoPuntos: 0 });
    const explicit = normalizarComprobanteLegacy({ total: 100, metodoPago: "efectivo", montoEfectivo: 40, montoTarjeta: 60, montoPuntos: 0 });
    expect(fallback).toMatchObject({ efectivo: 90, tarjeta: 0, valorPuntos: 0 });
    expect(explicit).toMatchObject({ efectivo: 40, tarjeta: 60, valorPuntos: 0 });
  });

  it("prefers resolved detail prices when legacy sale lines omit them", () => {
    const normalized = normalizarComprobanteLegacy({
      id: "legacy-paid",
      total: 50,
      metodoPago: "efectivo",
      lineasVenta: [{ producto: "p-1", cantidad: 1 }],
      detalle: [{ producto: "p-1", cantidad: 1, precio_actual: 50 }],
    });
    const result = calcularCorte({ ventas: [normalized] });
    expect(normalized.lineas[0]?.precioUnitario).toBe(50);
    expect(result.cortesias.cantidad).toBe(0);
    expect(result.warnings).not.toContain("LEGACY_ZERO_PRICE_AS_COURTESY");
  });
});

describe("corte snapshots", () => {
  it("persists every optional v2 snapshot from one calculation", () => {
    const calculation = calcularComprobantes([{ total: 100, metodoPago: "efectivo" }], {
      porcentajeComision: 10,
    });
    const snapshot = crearSnapshotCorte(calculation, {
      generatedAt: "2026-07-13T12:00:00.000Z",
      businessDate: "2026-07-13",
      jornadaId: "2026-07-13__J1",
      sesionCajaId: "session-1",
      conteoComprobantes: 1,
    });

    expect(snapshot).toMatchObject({
      calculationVersion: CALCULATION_VERSION,
      generatedAt: "2026-07-13T12:00:00.000Z",
      businessDate: "2026-07-13",
      jornadaId: "2026-07-13__J1",
      sesionCajaId: "session-1",
      conteoComprobantes: 1,
      totalesSnapshot: { dineroReal: 100, cantidadTickets: 1 },
      metodosPagoSnapshot: { efectivo: 100, tarjeta: 0, puntos: 0 },
      comisionSnapshot: { importeComision: 10 },
    });
    expect(snapshot).toHaveProperty("productosSnapshot");
    expect(snapshot).toHaveProperty("inventarioSnapshot");
    expect(snapshot).toHaveProperty("puntosSnapshot");
    expect(snapshot).toHaveProperty("abonadosSnapshot");
    expect(snapshot).toHaveProperty("cortesiasSnapshot");
    expect(snapshot).toHaveProperty("mermaSnapshot");
    expect(snapshot).toHaveProperty("promocionesSnapshot");
    expect(snapshot).toHaveProperty("combosSnapshot");
  });

  it("prefers a v2 snapshot and adapts historical cuts without snapshots", () => {
    const current = adaptarCortePersistido({
      totalReal: 999,
      totalEfectivo: 999,
      calculationVersion: CALCULATION_VERSION,
      totalesSnapshot: { dineroReal: 80, efectivoNeto: 50, tarjetaNeta: 30, ventasNetas: 100, cantidadTickets: 2 },
      metodosPagoSnapshot: { efectivo: 50, tarjeta: 30, puntos: 20 },
    });
    expect(current.finanzas).toMatchObject({ dineroReal: 80, efectivoNeto: 50, tarjetaNeta: 30, ventasNetas: 100 });

    const legacy = adaptarCortePersistido({
      totalReal: 75,
      totalCaja: 50,
      totalEfectivo: 50,
      totalTarjeta: 25,
      totalPuntosMonto: 10,
      totalPuntosCanjeados: 100,
      cantidadVentas: 3,
    });
    expect(legacy).toMatchObject({
      calculationVersion: LEGACY_CALCULATION_VERSION,
      finanzas: { dineroReal: 75, efectivoNeto: 50, tarjetaNeta: 25, valorPuntosCanjeados: 10, cantidadPuntosCanjeados: 100, cantidadTickets: 3 },
    });
  });

  it("falls back for null legacy scalars while preserving authoritative zero", () => {
    const absent = adaptarCortePersistido({
      totalCaja: 50,
      totalEfectivo: null,
      cantidadVentas: 3,
      conteoComprobantes: null,
    });
    const zero = adaptarCortePersistido({
      totalCaja: 50,
      totalEfectivo: 0,
      cantidadVentas: 3,
      conteoComprobantes: 0,
    });
    expect(absent.finanzas).toMatchObject({ efectivoNeto: 50, cantidadTickets: 3 });
    expect(absent.conteoComprobantes).toBe(3);
    expect(zero.finanzas).toMatchObject({ efectivoNeto: 0, cantidadTickets: 0 });
    expect(zero.conteoComprobantes).toBe(0);
  });
});
