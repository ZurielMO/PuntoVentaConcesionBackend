import {
  filterComprobantesByListFilters,
  matchesJornadaListFilter,
} from "../src/services/detalle-venta.service";
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

describe("matchesJornadaListFilter", () => {
  const jornadaId = "2026-09-12__J8";

  it("acepta jornadaId exacto de POS", () => {
    expect(
      matchesJornadaListFilter({ jornadaId: "2026-09-12__J8" }, jornadaId),
    ).toBe(true);
  });

  it("acepta jornadaId solo-fecha de VIP/palcos", () => {
    expect(
      matchesJornadaListFilter(
        {
          jornadaId: "2026-09-12",
          fecha: { _seconds: 1789200000 },
        },
        jornadaId,
      ),
    ).toBe(true);
  });

  it("acepta venta cobrada el mismo día de la fecha de jornada", () => {
    // 2026-09-12 18:00 UTC ≈ mediodía México
    expect(
      matchesJornadaListFilter(
        {
          jornadaId: "otro",
          fecha: {
            _seconds: Math.floor(Date.UTC(2026, 8, 12, 18, 0, 0) / 1000),
          },
        },
        jornadaId,
      ),
    ).toBe(true);
  });

  it("acepta inventario ligado a la jornada aunque jornadaId no coincida", () => {
    expect(
      matchesJornadaListFilter(
        {
          jornadaId: "2026-08-31",
          inventarioId: "2026-09-12__J8__njiNPAltziZ4aDQZEwau",
          fecha: {
            _seconds: Math.floor(Date.UTC(2026, 7, 31, 18, 0, 0) / 1000),
          },
        },
        jornadaId,
      ),
    ).toBe(true);
  });

  it("rechaza ventas de otra jornada/día/inventario", () => {
    expect(
      matchesJornadaListFilter(
        {
          jornadaId: "2026-08-31",
          inventarioId: "2026-08-22__J5__abc",
          fecha: {
            _seconds: Math.floor(Date.UTC(2026, 7, 31, 18, 0, 0) / 1000),
          },
        },
        jornadaId,
      ),
    ).toBe(false);
  });

  it("filtra el listado incluyendo palcos por día o inventario", () => {
    const rows = [
      {
        id: "pos",
        jornadaId: "2026-09-12__J8",
        inventarioId: "2026-09-12__J8__suc1",
      },
      {
        id: "vip-fecha",
        jornadaId: "2026-09-12",
        inventarioId: "x",
        fecha: {
          _seconds: Math.floor(Date.UTC(2026, 8, 12, 20, 0, 0) / 1000),
        },
      },
      {
        id: "vip-inv",
        jornadaId: "2026-08-31",
        inventarioId: "2026-09-12__J8__njiNPAltziZ4aDQZEwau",
      },
      {
        id: "otra",
        jornadaId: "2026-08-22__J5",
        inventarioId: "2026-08-22__J5__suc1",
        fecha: {
          _seconds: Math.floor(Date.UTC(2026, 7, 22, 18, 0, 0) / 1000),
        },
      },
    ];

    const filtered = filterComprobantesByListFilters(rows, { jornadaId });
    expect(filtered.map((r) => r.id).sort()).toEqual([
      "pos",
      "vip-fecha",
      "vip-inv",
    ]);
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
      matchesCorteCerradoHoy(
        corteCajaA,
        {
          concesionId: "c1",
          sucursalId: "s1",
          cajaId: "caja-a",
        },
        fecha,
      ),
    ).toBe(true);

    expect(
      matchesCorteCerradoHoy(
        corteCajaA,
        {
          concesionId: "c1",
          sucursalId: "s1",
          cajaId: "caja-b",
        },
        fecha,
      ),
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
      matchesCorteCerradoHoy(
        corteLegacy,
        {
          concesionId: "c1",
          sucursalId: "s1",
          cajaId: "caja-b",
        },
        fecha,
      ),
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
