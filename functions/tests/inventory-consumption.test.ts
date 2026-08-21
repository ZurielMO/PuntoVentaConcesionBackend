import {
  expandInventoryConsumptionDraws,
  findProductMatching,
  mergeInventoryDraws,
  productMatchesTokens,
  ruleAppliesToConcesion,
  INVENTORY_CONSUMPTION_RULES,
} from "../src/config/inventory-consumption.config";

const vasoRule = INVENTORY_CONSUMPTION_RULES.find(
  (rule) => rule.id === "vaso-cerveza-consume-piezas",
)!;

const catalog = [
  { id: "vaso-1", nombre: "Vaso de Cerveza" },
  { id: "pieza-1", nombre: "Pieza Cerveza" },
  { id: "otra", nombre: "Agua" },
];

describe("inventory-consumption.config", () => {
  it("aplica solo a concesiones cervecería", () => {
    expect(
      ruleAppliesToConcesion(vasoRule, null, "CERVECERIA PRUEBA"),
    ).toBe(true);
    expect(ruleAppliesToConcesion(vasoRule, null, "Cervecería León")).toBe(
      true,
    );
    expect(ruleAppliesToConcesion(vasoRule, null, "ICE")).toBe(false);
    expect(ruleAppliesToConcesion(vasoRule, null, "Fries Av.")).toBe(false);
  });

  it("detecta vaso y pieza por tokens de nombre", () => {
    expect(
      productMatchesTokens("vaso-1", "Vaso de Cerveza", ["vaso", "cerveza"]),
    ).toBe(true);
    expect(
      productMatchesTokens("pieza-1", "Pieza Cerveza", ["pieza", "cerveza"]),
    ).toBe(true);
    // Pieza no es vaso
    expect(
      productMatchesTokens("pieza-1", "Pieza Cerveza", ["vaso", "cerveza"]),
    ).toBe(false);
    // Solo "cerveza" no alcanza para trigger vaso
    expect(
      productMatchesTokens("pieza-1", "Pieza Cerveza", ["vaso", "cerveza"]),
    ).toBe(false);
  });

  it("encuentra pieza en catálogo", () => {
    const pieza = findProductMatching(catalog, ["pieza", "cerveza"]);
    expect(pieza?.id).toBe("pieza-1");
  });

  it("encuentra Cerveza unidad vía alias (producción)", () => {
    const catalogUnidad = [
      { id: "vaso-1", nombre: "Vaso de Cerveza" },
      { id: "unidad-1", nombre: "Cerveza unidad" },
    ];
    const unidad = findProductMatching(
      catalogUnidad,
      ["pieza", "cerveza"],
      undefined,
      [["unidad", "cerveza"]],
    );
    expect(unidad?.id).toBe("unidad-1");

    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "vaso-1", cantidad: 1 }],
      catalogProducts: catalogUnidad,
      concesionNombre: "Cervecería Poniente",
    });
    expect(draws).toEqual(
      expect.arrayContaining([
        { producto: "vaso-1", cantidad: 1 },
        { producto: "unidad-1", cantidad: 2 },
      ]),
    );
  });

  it("vender N vasos descuenta vaso N + pieza 2N", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "vaso-1", cantidad: 3 }],
      catalogProducts: catalog,
      concesionNombre: "CERVECERIA PRUEBA",
    });

    expect(mergeInventoryDraws(draws)).toEqual(
      expect.arrayContaining([
        { producto: "vaso-1", cantidad: 3 },
        { producto: "pieza-1", cantidad: 6 },
      ]),
    );
    expect(draws).toHaveLength(2);
  });

  it("vender piezas solas solo descuenta piezas 1:1", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "pieza-1", cantidad: 4 }],
      catalogProducts: catalog,
      concesionNombre: "CERVECERIA PRUEBA",
    });

    expect(draws).toEqual([{ producto: "pieza-1", cantidad: 4 }]);
  });

  it("vaso + pieza en la misma venta acumula piezas (2N + M)", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [
        { producto: "vaso-1", cantidad: 1 },
        { producto: "pieza-1", cantidad: 1 },
      ],
      catalogProducts: catalog,
      concesionNombre: "Cervecería",
    });

    const byId = new Map(draws.map((d) => [d.producto, d.cantidad]));
    expect(byId.get("vaso-1")).toBe(1);
    expect(byId.get("pieza-1")).toBe(3); // 2 del vaso + 1 de la pieza
  });

  it("no aplica fuera de cervecería", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "vaso-1", cantidad: 1 }],
      catalogProducts: catalog,
      concesionNombre: "ICE",
    });

    expect(draws).toEqual([{ producto: "vaso-1", cantidad: 1 }]);
  });

  it("abonado/precio no afecta la matemática de consumo", () => {
    // Las líneas ya traen cantidad; el precio abonado no participa.
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "vaso-1", cantidad: 2 }],
      catalogProducts: catalog,
      concesionNombre: "CERVECERIA PRUEBA",
    });

    const pieza = draws.find((d) => d.producto === "pieza-1");
    expect(pieza?.cantidad).toBe(4);
  });

  it("falla si se vende vaso y no existe pieza en catálogo", () => {
    expect(() =>
      expandInventoryConsumptionDraws({
        lineas: [{ producto: "vaso-1", cantidad: 1 }],
        catalogProducts: [{ id: "vaso-1", nombre: "Vaso de Cerveza" }],
        concesionNombre: "Cervecería",
      }),
    ).toThrow(/CONSUMPTION_PRODUCT_NOT_FOUND/);
  });

  it("stock insuficiente se expresa como draw > disponible (validación caller)", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "vaso-1", cantidad: 1 }],
      catalogProducts: catalog,
      concesionNombre: "Cervecería",
    });
    const piezaDraw = draws.find((d) => d.producto === "pieza-1")!;
    const piezaStock = 1;
    expect(piezaDraw.cantidad).toBe(2);
    expect(piezaDraw.cantidad > piezaStock).toBe(true);
  });
});

describe("SUTEP promo consume cerveza base", () => {
  const catalogSutep = [
    { id: "promo-victoria", nombre: "PROMO VICTORIA" },
    { id: "victoria", nombre: "VICTORIA" },
    { id: "promo-corona", nombre: "PROMO CORONA" },
    { id: "corona", nombre: "CORONA" },
  ];

  it("en catalogo ICE sin promos no descuenta victoria", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "promo-victoria", cantidad: 2 }],
      catalogProducts: catalog,
      concesionNombre: "ICE",
    });
    expect(draws).toEqual([{ producto: "promo-victoria", cantidad: 2 }]);
  });

  it("2 promo victoria descuenta 2 victoria", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "promo-victoria", cantidad: 2 }],
      catalogProducts: catalogSutep,
      concesionNombre: "SUTEP",
    });
    const byId = new Map(draws.map((d) => [d.producto, d.cantidad]));
    expect(byId.get("promo-victoria")).toBe(2);
    expect(byId.get("victoria")).toBe(2);
  });

  it("2 promo corona descuenta 2 corona", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "promo-corona", cantidad: 2 }],
      catalogProducts: catalogSutep,
      concesionNombre: "SUTEP",
    });
    const byId = new Map(draws.map((d) => [d.producto, d.cantidad]));
    expect(byId.get("promo-corona")).toBe(2);
    expect(byId.get("corona")).toBe(2);
  });

  it("no toma PROMO VICTORIA como el SKU victoria", () => {
    const promoFirst = [
      { id: "promo-victoria", nombre: "PROMO VICTORIA" },
      { id: "victoria", nombre: "VICTORIA" },
    ];
    const linked = findProductMatching(
      promoFirst,
      ["victoria"],
      undefined,
      undefined,
      ["promo"],
    );
    expect(linked?.id).toBe("victoria");
  });

  it("vender victoria suelta no toca la promo", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "victoria", cantidad: 2 }],
      catalogProducts: catalogSutep,
      concesionNombre: "SUTEP",
    });
    expect(draws).toEqual([{ producto: "victoria", cantidad: 2 }]);
  });

  it("descuenta victoria aunque el inicial de promo y victoria no cuadren", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "promo-victoria", cantidad: 2 }],
      catalogProducts: catalogSutep,
      concesionNombre: "SUTEP",
    });
    const byId = new Map(draws.map((d) => [d.producto, d.cantidad]));
    expect(byId.get("promo-victoria")).toBe(2);
    expect(byId.get("victoria")).toBe(2);
  });

  it("aplica por catalogo aunque el nombre de concesion no sea SUTEP", () => {
    const draws = expandInventoryConsumptionDraws({
      lineas: [{ producto: "promo-corona", cantidad: 2 }],
      catalogProducts: catalogSutep,
      concesionNombre: "HAPPY HOUR 7",
    });
    const byId = new Map(draws.map((d) => [d.producto, d.cantidad]));
    expect(byId.get("promo-corona")).toBe(2);
    expect(byId.get("corona")).toBe(2);
  });
});
