import { mergeResolvedLineas, resolvePrecio } from "../src/services/detalle-venta.service";

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
  it("combina cantidades y subtotales del mismo producto", () => {
    const merged = mergeResolvedLineas([
      {
        producto: "ice-grande",
        cantidad: 1,
        precio_actual: 50,
        subtotal: 50,
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
      precio_actual: 65,
      subtotal: 130,
    });
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
