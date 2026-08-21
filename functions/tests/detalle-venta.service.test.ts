import { computeVentaTotal, mergeResolvedLineas, resolvePrecio } from "../src/services/detalle-venta.service";

describe("resolvePrecio", () => {
  it("prioriza precio_actual del POS sobre precio_jornada e inventario", () => {
    expect(
      resolvePrecio(
        64,
        { precio_jornada: 80 },
        { precio: 80 },
      ),
    ).toBe(64);
  });

  it("usa precio_jornada si el POS no envía precio", () => {
    expect(resolvePrecio(undefined, { precio_jornada: 75 }, { precio: 80 })).toBe(
      75,
    );
  });

  it("usa precio de catálogo como fallback", () => {
    expect(resolvePrecio(undefined, {}, { precio: 80 })).toBe(80);
  });
});

describe("mergeResolvedLineas", () => {
  it("combina cantidades del mismo producto al mismo precio", () => {
    const merged = mergeResolvedLineas([
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 80,
        subtotal: 80,
      },
      {
        producto: "gomitas",
        cantidad: 1,
        precio_actual: 30,
        subtotal: 30,
      },
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 80,
        subtotal: 80,
      },
    ]);

    expect(merged).toHaveLength(2);

    const ice = merged.find((linea) => linea.producto === "ice-grande");
    expect(ice).toEqual({
      producto: "ice-grande",
      cantidad: 2,
      precio_actual: 80,
      subtotal: 160,
    });
  });

  it("no promedia 2x1: conserva pagada @ catálogo y cortesía @ $0", () => {
    const merged = mergeResolvedLineas([
      {
        producto: "papas-grandes",
        cantidad: 1,
        precio_actual: 150,
        subtotal: 150,
      },
      {
        producto: "papas-grandes",
        cantidad: 1,
        precio_actual: 0,
        subtotal: 0,
      },
    ]);

    expect(merged).toEqual([
      {
        producto: "papas-grandes",
        cantidad: 1,
        precio_actual: 150,
        subtotal: 150,
      },
      {
        producto: "papas-grandes",
        cantidad: 1,
        precio_actual: 0,
        subtotal: 0,
      },
    ]);

    // Regresión: el merge viejo (solo por producto) hacía 2 × $75.
    expect(merged).not.toEqual([
      {
        producto: "papas-grandes",
        cantidad: 2,
        precio_actual: 75,
        subtotal: 150,
      },
    ]);
  });

  it("ICE 2x1: misma forma pagada @ catálogo + cortesía @ $0", () => {
    const merged = mergeResolvedLineas([
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 80,
        subtotal: 80,
      },
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 0,
        subtotal: 0,
      },
    ]);

    expect(merged).toEqual([
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 80,
        subtotal: 80,
      },
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 0,
        subtotal: 0,
      },
    ]);
  });

  it("conserva distinto precio del mismo producto sin promediar", () => {
    const merged = mergeResolvedLineas([
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 50,
        subtotal: 50,
      },
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 80,
        subtotal: 80,
      },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.find((l) => l.precio_actual === 50)?.cantidad).toBe(1);
    expect(merged.find((l) => l.precio_actual === 80)?.cantidad).toBe(1);
  });

  it("conserva líneas únicas sin cambios", () => {
    const input = [
      {
        producto: "combo-only",
        cantidad: 3,
        precio_actual: 10,
        subtotal: 30,
      },
    ];

    expect(mergeResolvedLineas(input)).toEqual(input);
  });
});

describe("computeVentaTotal", () => {
  const lineas = [{ subtotal: 130 }];

  it("resta el descuento MONTO del total de líneas", () => {
    expect(
      computeVentaTotal(lineas, {
        benefitId: "desc-1",
        titulo: "Descuento abonado cerveza",
        montoTotal: 130,
        montoDescuento: 40,
        unidadesGratis: 0,
        tipo: "MONTO",
      }),
    ).toBe(90);
  });

  it("no vuelve a restar 2x1 ni porcentaje (ya va en el precio de línea)", () => {
    expect(
      computeVentaTotal([{ subtotal: 80 }], {
        benefitId: "2x1",
        titulo: "ABONADOS 2X1",
        montoTotal: 80,
        montoDescuento: 80,
        unidadesGratis: 1,
        tipo: "2X1",
      }),
    ).toBe(80);
  });
});
