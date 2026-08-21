import {
  isQuantityPromo,
  mapDescuentoToBenefit,
} from "../src/config/abonado-benefits.config";

describe("beneficios limitados por jornada", () => {
  it("2x1 y 3x2 se agotan: uno por promoción, por abonado, por jornada", () => {
    expect(isQuantityPromo("2X1")).toBe(true);
    expect(isQuantityPromo("3X2")).toBe(true);
  });

  it("monto y porcentaje se pueden usar cuantas veces quiera", () => {
    expect(isQuantityPromo("MONTO")).toBe(false);
    expect(isQuantityPromo("PORCENTAJE")).toBe(false);
  });
});

describe("mapDescuentoToBenefit", () => {
  it("mapea un 2x1 activo con productos de la concesión", () => {
    expect(
      mapDescuentoToBenefit({
        id: "UboJ59rN4TpMHjkbSFp4",
        activo: true,
        concesion_id: "DNKNbnFxnfOey3bhb33h",
        producto_ids: ["mbBfo6rNQNa8omqtjabU"],
        tipo: "2X1",
        titulo: "ABONADOS 2X1",
        descripcion: "SOLO ABONADOS",
        valor: null,
      }),
    ).toEqual({
      id: "UboJ59rN4TpMHjkbSFp4",
      titulo: "ABONADOS 2X1",
      descripcion: "SOLO ABONADOS",
      tipo: "2X1",
      productIds: ["mbBfo6rNQNa8omqtjabU"],
      concesionIds: ["DNKNbnFxnfOey3bhb33h"],
      valor: null,
    });
  });

  it("ignora descuentos inactivos", () => {
    expect(
      mapDescuentoToBenefit({
        id: "x",
        activo: false,
        concesion_id: "c1",
        producto_ids: ["p1"],
        tipo: "2X1",
        titulo: "ABONADOS 2X1",
      }),
    ).toBeNull();
  });

  it("ignora descuentos sin productos", () => {
    expect(
      mapDescuentoToBenefit({
        id: "x",
        activo: true,
        concesion_id: "c1",
        producto_ids: [],
        tipo: "2X1",
        titulo: "ABONADOS 2X1",
      }),
    ).toBeNull();
  });

  it("mapea porcentaje con valor", () => {
    expect(
      mapDescuentoToBenefit({
        id: "pct",
        activo: true,
        concesion_id: "c1",
        producto_ids: ["p1", "p1", " p2 "],
        tipo: "PORCENTAJE",
        titulo: "10% abonado",
        descripcion: "",
        valor: 10,
      }),
    ).toMatchObject({
      tipo: "PORCENTAJE",
      productIds: ["p1", "p2"],
      valor: 10,
    });
  });
});
