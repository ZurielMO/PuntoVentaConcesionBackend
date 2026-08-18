import { filterComprobantesByListFilters } from "../src/services/detalle-venta.service";
import { matchesCorteCerradoHoy } from "../src/services/corte-guard.service";

const ventasFixture = [
  {
    id: "v1",
    concesionId: "c1",
    sucursalId: "s1",
    inventarioId: "inv1",
    cajaId: "caja-a",
    idUser: "user-a",
    total: 100,
  },
  {
    id: "v2",
    concesionId: "c1",
    sucursalId: "s1",
    inventarioId: "inv1",
    cajaId: "caja-b",
    idUser: "user-b",
    total: 80,
  },
  {
    id: "v3",
    concesionId: "c1",
    sucursalId: "s1",
    inventarioId: "inv1",
    idUser: "user-c",
    total: 50,
  },
];

describe("filterComprobantesByListFilters", () => {
  it("aisla ventas por caja dentro de la misma sucursal", () => {
    expect(
      filterComprobantesByListFilters(ventasFixture, {
        concesionId: "c1",
        sucursalId: "s1",
        cajaId: "caja-a",
      }),
    ).toEqual([ventasFixture[0]]);

    expect(
      filterComprobantesByListFilters(ventasFixture, {
        concesionId: "c1",
        sucursalId: "s1",
        cajaId: "caja-b",
      }),
    ).toEqual([ventasFixture[1]]);
  });

  it("excluye ventas históricas sin cajaId cuando se filtra por caja", () => {
    expect(
      filterComprobantesByListFilters(ventasFixture, {
        concesionId: "c1",
        sucursalId: "s1",
        cajaId: "caja-a",
      }).some((venta) => venta.id === "v3"),
    ).toBe(false);
  });

  it("sin filtro de caja devuelve todas las ventas de la sucursal", () => {
    expect(
      filterComprobantesByListFilters(ventasFixture, {
        concesionId: "c1",
        sucursalId: "s1",
      }),
    ).toHaveLength(3);
  });
});

describe("matchesCorteCerradoHoy", () => {
  const fecha = "2026-07-09";

  it("considera corte cerrado solo para la caja solicitada", () => {
    const corteCajaA = {
      estatus: "CERRADO",
      fecha,
      concesionId: "c1",
      sucursalId: "s1",
      cajaId: "caja-a",
      idUser: "user-a",
    };

    expect(
      matchesCorteCerradoHoy(corteCajaA, {
        concesionId: "c1",
        sucursalId: "s1",
        cajaId: "caja-a",
      }, fecha),
    ).toBe(true);

    expect(
      matchesCorteCerradoHoy(corteCajaA, {
        concesionId: "c1",
        sucursalId: "s1",
        cajaId: "caja-b",
      }, fecha),
    ).toBe(false);
  });

  it("no bloquea cajas nuevas con cortes históricos sin cajaId", () => {
    const corteLegacy = {
      estatus: "CERRADO",
      fecha,
      concesionId: "c1",
      sucursalId: "s1",
      idUser: "user-a",
    };

    expect(
      matchesCorteCerradoHoy(corteLegacy, {
        concesionId: "c1",
        sucursalId: "s1",
        cajaId: "caja-b",
      }, fecha),
    ).toBe(false);
  });

  it("bloquea al mismo cajero con corte legacy sin cajaId", () => {
    const corteLegacy = {
      estatus: "CERRADO",
      fecha,
      concesionId: "c1",
      sucursalId: "s1",
      idUser: "user-a",
    };

    expect(
      matchesCorteCerradoHoy(
        corteLegacy,
        {
          concesionId: "c1",
          sucursalId: "s1",
          cajaId: "caja-a",
          idUser: "user-a",
        },
        fecha,
      ),
    ).toBe(true);

    expect(
      matchesCorteCerradoHoy(
        corteLegacy,
        {
          concesionId: "c1",
          sucursalId: "s1",
          cajaId: "caja-a",
          idUser: "user-b",
        },
        fecha,
      ),
    ).toBe(false);
  });
});
