import {
  aggregateTotalsByMetodoPago,
  aggregateProductosFromVentas,
  aggregatePromociones2x1FromVentas,
  aggregateTiposVentaFromVentas,
  aggregateProductoReporteFromVentas,
  buildReporteProductoTotales,
  aggregateFierabonadosFromVentas,
  aggregateCombosFromVentas,
  computeDiferenciaCaja,
  buildCorteWritePayload,
  CERVEZA_ABONADO_BENEFIT_ID,
  ICE_2X1_BENEFIT_ID,
  PAPAS_2X1_BENEFIT_ID,
} from "../src/services/corte.service";
import {
  assertNoCorteCerradoForVenta,
  CORTE_CLOSED_VENTA_MESSAGE,
} from "../src/services/corte-guard.service";
import { ApiError } from "../src/utils/api-error";

describe("computeDiferenciaCaja", () => {
  it("calcula sobrante cuando lo contado supera lo esperado", () => {
    expect(computeDiferenciaCaja(120, 100)).toEqual({
      efectivoContado: 120,
      diferenciaCaja: 20,
    });
  });

  it("calcula faltante cuando lo contado es menor a lo esperado", () => {
    expect(computeDiferenciaCaja(90.5, 100)).toEqual({
      efectivoContado: 90.5,
      diferenciaCaja: -9.5,
    });
  });

  it("diferencia exacta es 0", () => {
    expect(computeDiferenciaCaja(100, 100)).toEqual({
      efectivoContado: 100,
      diferenciaCaja: 0,
    });
  });

  it("devuelve nulos si no se ingresó efectivo contado", () => {
    expect(computeDiferenciaCaja(undefined, 100)).toEqual({
      efectivoContado: null,
      diferenciaCaja: null,
    });
    expect(computeDiferenciaCaja(null, 100)).toEqual({
      efectivoContado: null,
      diferenciaCaja: null,
    });
  });
});

describe("aggregateTotalsByMetodoPago", () => {
  it("agrupa totales por efectivo y tarjeta", () => {
    expect(
      aggregateTotalsByMetodoPago([
        { total: 100, metodoPago: "efectivo" },
        { total: 50, metodoPago: "tarjeta" },
        { total: 25, metodoPago: "tarjeta" },
      ]),
    ).toEqual({
      totalEfectivo: 100,
      totalTarjeta: 75,
      totalPuntosMonto: 0,
      totalPuntosCanjeados: 0,
      ventasConPuntos: 0,
    });
  });

  it("trata ventas sin metodoPago como efectivo", () => {
    expect(
      aggregateTotalsByMetodoPago([
        { total: 80 },
        { total: 20, metodoPago: "efectivo" },
      ]),
    ).toEqual({
      totalEfectivo: 100,
      totalTarjeta: 0,
      totalPuntosMonto: 0,
      totalPuntosCanjeados: 0,
      ventasConPuntos: 0,
    });
  });

  it("agrupa ventas con puntos y remanente en efectivo o tarjeta", () => {
    expect(
      aggregateTotalsByMetodoPago([
        {
          total: 80,
          metodoPago: "puntos",
          puntosUsados: 800,
          montoPuntos: 80,
          montoEfectivo: 0,
          montoTarjeta: 0,
        },
        {
          total: 80,
          metodoPago: "puntos+efectivo",
          puntosUsados: 500,
          montoPuntos: 50,
          montoEfectivo: 30,
          montoTarjeta: 0,
        },
        {
          total: 100,
          metodoPago: "puntos+tarjeta",
          puntosUsados: 400,
          montoPuntos: 40,
          montoEfectivo: 0,
          montoTarjeta: 60,
        },
      ]),
    ).toEqual({
      totalEfectivo: 30,
      totalTarjeta: 60,
      totalPuntosMonto: 170,
      totalPuntosCanjeados: 1700,
      ventasConPuntos: 3,
    });
  });

  it("los puntos NO son dinero: total real = efectivo + tarjeta (sin puntos)", () => {
    const ventas = [
      { total: 210, metodoPago: "efectivo", montoEfectivo: 210 },
      { total: 250, metodoPago: "tarjeta", montoTarjeta: 250 },
      {
        total: 50,
        metodoPago: "puntos",
        puntosUsados: 500,
        montoPuntos: 50,
        montoEfectivo: 0,
        montoTarjeta: 0,
      },
    ];
    const totals = aggregateTotalsByMetodoPago(ventas);

    expect(totals).toEqual({
      totalEfectivo: 210,
      totalTarjeta: 250,
      totalPuntosMonto: 50,
      totalPuntosCanjeados: 500,
      ventasConPuntos: 1,
    });

    // Dinero real recibido = efectivo + tarjeta. Los puntos quedan aparte.
    const totalReal = totals.totalEfectivo + totals.totalTarjeta;
    expect(totalReal).toBe(460);
    // El monto en puntos es informativo y NO se suma al dinero real.
    expect(totalReal).not.toBe(totalReal + totals.totalPuntosMonto);
  });
});

describe("aggregateProductosFromVentas", () => {
  it("usa lineasVenta y conserva el precio real de un 2x1 sin dividir", () => {
    const productNames = new Map([["ice", "ICE Grande"]]);

    // 2x1: la venta llega como 1 unidad a $80 (pagada) y 1 unidad a $0 (gratis).
    // NO debe promediarse a $40.
    expect(
      aggregateProductosFromVentas(
        [
          {
            total: 80,
            lineasVenta: [
              { producto: "ice", cantidad: 1, precio_actual: 80 },
              { producto: "ice", cantidad: 1, precio_actual: 0 },
            ],
            detalle: [
              // detalle fusionado (aplanado a 40): debe ignorarse porque hay lineasVenta.
              { producto: "ice", cantidad: 2, precio_actual: 40, subtotal: 80 },
            ],
          },
        ],
        productNames,
      ),
    ).toEqual([
      {
        productoId: "ice",
        nombre: "ICE Grande",
        cantidad: 1,
        subtotal: 80,
        precioUnitario: 80,
      },
      {
        productoId: "ice",
        nombre: "ICE Grande",
        cantidad: 1,
        subtotal: 0,
        precioUnitario: 0,
      },
    ]);
  });

  it("omite combos de lineasVenta (se cuentan aparte)", () => {
    expect(
      aggregateProductosFromVentas([
        {
          total: 100,
          lineasVenta: [
            { producto: "p1", cantidad: 1, precio_actual: 50 },
            { combo: "c1", cantidad: 1, precio_actual: 50 },
          ],
        },
      ]),
    ).toEqual([
      {
        productoId: "p1",
        nombre: "Producto",
        cantidad: 1,
        subtotal: 50,
        precioUnitario: 50,
      },
    ]);
  });

  it("agrupa por producto+precio real sin promediar", () => {
    const productNames = new Map([
      ["p1", "Café"],
      ["p2", "Pan"],
    ]);

    expect(
      aggregateProductosFromVentas(
        [
          {
            total: 150,
            lineasVenta: [
              { producto: "p1", cantidad: 2, precio_actual: 50 },
              { producto: "p2", cantidad: 1, precio_actual: 50 },
            ],
          },
          {
            total: 130,
            lineasVenta: [
              { producto: "p1", cantidad: 2, precio_actual: 50 },
              { producto: "p1", cantidad: 1, precio_actual: 80 },
            ],
          },
        ],
        productNames,
      ),
    ).toEqual([
      {
        productoId: "p1",
        nombre: "Café",
        cantidad: 4,
        subtotal: 200,
        precioUnitario: 50,
      },
      {
        productoId: "p1",
        nombre: "Café",
        cantidad: 1,
        subtotal: 80,
        precioUnitario: 80,
      },
      {
        productoId: "p2",
        nombre: "Pan",
        cantidad: 1,
        subtotal: 50,
        precioUnitario: 50,
      },
    ]);
  });

  it("usa detalle como respaldo para ventas históricas sin lineasVenta", () => {
    const productNames = new Map([["p1", "Café"]]);

    expect(
      aggregateProductosFromVentas(
        [
          {
            total: 100,
            detalle: [
              { producto: "p1", cantidad: 2, precio_actual: 50, subtotal: 100 },
            ],
          },
        ],
        productNames,
      ),
    ).toEqual([
      {
        productoId: "p1",
        nombre: "Café",
        cantidad: 2,
        subtotal: 100,
        precioUnitario: 50,
      },
    ]);
  });

  it("devuelve vacío si las ventas no traen detalle", () => {
    expect(
      aggregateProductosFromVentas([{ total: 100 }, { total: 50 }]),
    ).toEqual([]);
  });
});

describe("aggregatePromociones2x1FromVentas", () => {
  it("suma montos y conteos de ventas con abonado 2x1", () => {
    expect(
      aggregatePromociones2x1FromVentas([
        {
          total: 80,
          abonado: {
            benefitId: ICE_2X1_BENEFIT_ID,
            titulo: "ICE 2x1",
            montoTotal: 80,
            montoDescuento: 40,
            unidadesGratis: 1,
          },
        },
        {
          total: 50,
          abonado: {
            benefitId: ICE_2X1_BENEFIT_ID,
            titulo: "ICE 2x1",
            montoTotal: 120,
            montoDescuento: 40,
            unidadesGratis: 1,
          },
        },
        { total: 30 },
      ]),
    ).toEqual({
      montoTotal: 200,
      montoDescuento: 80,
      unidadesGratis: 2,
      cantidadTransacciones: 2,
    });
  });

  it("incluye papas 2x1 en promociones 2x1 del corte", () => {
    expect(
      aggregatePromociones2x1FromVentas([
        {
          total: 150,
          abonado: {
            benefitId: PAPAS_2X1_BENEFIT_ID,
            titulo: "Papas 2x1",
            montoTotal: 150,
            montoDescuento: 150,
            unidadesGratis: 1,
          },
        },
      ]),
    ).toEqual({
      montoTotal: 150,
      montoDescuento: 150,
      unidadesGratis: 1,
      cantidadTransacciones: 1,
    });
  });

  it("ignora precio abonado cerveza (no es 2x1)", () => {
    expect(
      aggregatePromociones2x1FromVentas([
        {
          total: 450,
          abonado: {
            benefitId: CERVEZA_ABONADO_BENEFIT_ID,
            titulo: "Precio abonado cerveza",
            montoTotal: 450,
            montoDescuento: 200,
            unidadesGratis: 0,
          },
        },
      ]),
    ).toEqual({
      montoTotal: 0,
      montoDescuento: 0,
      unidadesGratis: 0,
      cantidadTransacciones: 0,
    });
  });

  it("ignora ventas sin descuento abonado", () => {
    expect(
      aggregatePromociones2x1FromVentas([
        {
          total: 80,
          abonado: {
            benefitId: "ice-2x1",
            titulo: "ICE 2x1",
            montoTotal: 80,
            montoDescuento: 0,
            unidadesGratis: 0,
          },
        },
      ]),
    ).toEqual({
      montoTotal: 0,
      montoDescuento: 0,
      unidadesGratis: 0,
      cantidadTransacciones: 0,
    });
  });
});

describe("aggregateTiposVentaFromVentas", () => {
  it("clasifica venta normal, abonado, abonado con puntos y normal con puntos", () => {
    const rows = aggregateTiposVentaFromVentas([
      {
        total: 130,
        metodoPago: "efectivo",
        montoEfectivo: 130,
      },
      {
        total: 390,
        metodoPago: "tarjeta",
        montoTarjeta: 390,
      },
      {
        total: 180,
        metodoPago: "efectivo",
        montoEfectivo: 180,
        abonado: {
          benefitId: "cerveza-precio-abonado",
          titulo: "Precio abonado cerveza",
          montoTotal: 180,
          montoDescuento: 80,
          unidadesGratis: 0,
        },
      },
      {
        total: 270,
        metodoPago: "tarjeta",
        montoTarjeta: 270,
        abonado: {
          benefitId: "cerveza-precio-abonado",
          titulo: "Precio abonado cerveza",
          montoTotal: 270,
          montoDescuento: 120,
          unidadesGratis: 0,
        },
      },
      {
        total: 90,
        metodoPago: "puntos",
        puntosUsados: 900,
        montoPuntos: 90,
        abonado: {
          benefitId: "cerveza-precio-abonado",
          titulo: "Precio abonado cerveza",
          montoTotal: 90,
          montoDescuento: 40,
          unidadesGratis: 0,
        },
      },
    ]);

    const byTipo = Object.fromEntries(rows.map((r) => [r.tipo, r]));

    expect(byTipo.normal).toMatchObject({
      transacciones: 2,
      efectivo: 130,
      tarjeta: 390,
      puntosMonto: 0,
      valorTotal: 520,
    });
    expect(byTipo.abonado).toMatchObject({
      transacciones: 2,
      efectivo: 180,
      tarjeta: 270,
      descuentoAbonado: 200,
      valorTotal: 450,
    });
    expect(byTipo.abonado_puntos).toMatchObject({
      transacciones: 1,
      puntosMonto: 90,
      puntosCanjeados: 900,
      descuentoAbonado: 40,
      valorTotal: 90,
    });
    expect(byTipo.normal_puntos).toMatchObject({
      transacciones: 0,
      efectivo: 0,
      tarjeta: 0,
      puntosMonto: 0,
    });
  });

  it("siempre devuelve las 4 filas con etiquetas fijas", () => {
    const rows = aggregateTiposVentaFromVentas([]);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.tipo)).toEqual([
      "normal",
      "abonado",
      "abonado_puntos",
      "normal_puntos",
    ]);
    expect(rows[0].etiqueta).toBe("Venta normal");
  });
});

describe("aggregateProductoReporteFromVentas", () => {
  it("desglosa cantidades y montos regular, abonado, cortesías y puntos por producto", () => {
    const byProduct = aggregateProductoReporteFromVentas([
      {
        total: 130,
        metodoPago: "efectivo",
        montoEfectivo: 130,
        detalle: [
          { producto: "cerveza", cantidad: 1, precio_actual: 130, subtotal: 130 },
        ],
      },
      {
        total: 390,
        metodoPago: "tarjeta",
        montoTarjeta: 390,
        detalle: [
          { producto: "cerveza", cantidad: 3, precio_actual: 130, subtotal: 390 },
        ],
      },
      {
        total: 180,
        metodoPago: "efectivo",
        montoEfectivo: 180,
        abonado: {
          montoDescuento: 80,
          montoTotal: 180,
          unidadesGratis: 0,
        },
        detalle: [
          { producto: "cerveza", cantidad: 2, precio_actual: 90, subtotal: 180 },
        ],
      },
      {
        total: 90,
        metodoPago: "puntos",
        montoPuntos: 90,
        puntosUsados: 900,
        abonado: {
          montoDescuento: 40,
          montoTotal: 90,
          unidadesGratis: 0,
        },
        detalle: [
          { producto: "cerveza", cantidad: 1, precio_actual: 90, subtotal: 90 },
        ],
      },
    ]);

    const cerveza = byProduct.get("cerveza");
    expect(cerveza).toMatchObject({
      cantidadRegular: 4,
      cantidadAbonado: 3,
      ventasRegular: 520,
      ventasAbonado: 270,
      puntosCanjeados: 90,
      ventasTotales: 790,
    });

    const totales = buildReporteProductoTotales([cerveza!]);
    expect(totales.ventasTotales).toBe(790);
    expect(totales.puntosCanjeados).toBe(90);
    expect(totales.dineroReal).toBe(700);
  });
});

describe("aggregateFierabonadosFromVentas", () => {
  it("suma cervezas vendidas a precio abonado", () => {
    expect(
      aggregateFierabonadosFromVentas([
        {
          total: 450,
          abonado: {
            benefitId: CERVEZA_ABONADO_BENEFIT_ID,
            titulo: "Precio abonado cerveza",
            montoTotal: 450,
            montoDescuento: 200,
            unidadesGratis: 0,
          },
          lineasVenta: [
            { producto: "cerveza1", cantidad: 5, precio_actual: 90 },
          ],
        },
        {
          total: 80,
          abonado: {
            benefitId: ICE_2X1_BENEFIT_ID,
            titulo: "ICE 2x1",
            montoTotal: 80,
            montoDescuento: 40,
            unidadesGratis: 1,
          },
        },
      ]),
    ).toEqual({
      cantidadUnidades: 5,
      montoTotal: 450,
      montoDescuento: 200,
      cantidadTransacciones: 1,
    });
  });
});

describe("assertNoCorteCerradoForVenta", () => {
  it("rechaza venta si hay corte cerrado hoy", () => {
    expect(() => assertNoCorteCerradoForVenta({ id: "corte-1" })).toThrow(
      CORTE_CLOSED_VENTA_MESSAGE,
    );
  });

  it("usa código CORTE_ALREADY_CLOSED (409)", () => {
    try {
      assertNoCorteCerradoForVenta({ id: "corte-1" });
      fail("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.statusCode).toBe(409);
      expect(apiError.code).toBe("CORTE_ALREADY_CLOSED");
    }
  });

  it("permite venta si no hay corte cerrado hoy", () => {
    expect(() => assertNoCorteCerradoForVenta(null)).not.toThrow();
    expect(() => assertNoCorteCerradoForVenta(undefined)).not.toThrow();
  });
});

describe("buildCorteWritePayload", () => {
  it("persiste cajaId y cajaNombre al cerrar corte", () => {
    const payload = buildCorteWritePayload(
      {
        concesionId: "c1",
        sucursalId: "s1",
        idUser: "user-1",
        ventaId: null,
        cajaId: "caja-a",
        cajaNombre: "Caja 1",
      },
      {
        fecha: "2026-07-28",
        estatus: "CERRADO",
        totalReal: 100,
        totalCaja: 80,
        efectivoContado: 80,
        diferenciaCaja: 0,
        jornadaId: "2026-07-28__J1",
        inventarioId: "inv-1",
      },
    );

    expect(payload.cajaId).toBe("caja-a");
    expect(payload.cajaNombre).toBe("Caja 1");
    expect(payload.estatus).toBe("CERRADO");
    expect(payload.fecha).toBe("2026-07-28");
    expect(payload.idUser).toBe("user-1");
  });
});

describe("aggregateCombosFromVentas", () => {
  it("agrupa combos desde lineasVenta", () => {
    const comboNames = new Map([
      ["c1", "Combo Familiar"],
      ["c2", "Combo Pareja"],
    ]);

    expect(
      aggregateCombosFromVentas(
        [
          {
            total: 200,
            lineasVenta: [
              { combo: "c1", cantidad: 2, precio_actual: 100 },
              { producto: "p1", cantidad: 1, precio_actual: 50 },
            ],
          },
          {
            total: 80,
            lineasVenta: [{ combo: "c2", cantidad: 1, precio_actual: 80 }],
          },
        ],
        comboNames,
      ),
    ).toEqual({
      montoTotal: 280,
      cantidadVendidos: 3,
      items: [
        {
          comboId: "c1",
          nombre: "Combo Familiar",
          cantidadVendidos: 2,
          montoTotal: 200,
        },
        {
          comboId: "c2",
          nombre: "Combo Pareja",
          cantidadVendidos: 1,
          montoTotal: 80,
        },
      ],
    });
  });

  it("devuelve vacío si no hay lineasVenta con combo", () => {
    expect(
      aggregateCombosFromVentas([
        { total: 100, detalle: [{ producto: "p1", cantidad: 1, subtotal: 100 }] },
      ]),
    ).toEqual({
      montoTotal: 0,
      cantidadVendidos: 0,
      items: [],
    });
  });
});
