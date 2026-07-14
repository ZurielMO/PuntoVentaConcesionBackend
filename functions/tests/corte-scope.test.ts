import { resolveCorteScope } from "../src/domain/cortes/corte-scope";

describe("resolveCorteScope", () => {
  it("forces a seller to the authenticated identity and ignores requested scope", () => {
    expect(resolveCorteScope(
      {
        uid: "seller-1",
        rol: "CONCESION_VENDEDOR",
        concesionId: "concession-a",
        sucursalId: "branch-a",
        cajaId: "cash-a",
      },
      {
        concesionId: "concession-b",
        sucursalId: "branch-b",
        cajaId: "cash-b",
        idUser: "seller-2",
      },
    )).toMatchObject({
      role: "VENDEDOR",
      concesionId: "concession-a",
      sucursalId: "branch-a",
      cajaId: "cash-a",
      idUser: "seller-1",
    });
  });

  it("lets an admin filter all sellers and boxes only inside the authenticated concession", () => {
    expect(resolveCorteScope(
      { uid: "admin-1", rol: "CONCESION_ADMIN", concesionId: "concession-a" },
      { concesionId: "concession-b", sucursalId: "branch-a", cajaId: "cash-a", idUser: "seller-2" },
    )).toMatchObject({
      role: "ADMIN",
      concesionId: "concession-a",
      sucursalId: "branch-a",
      cajaId: "cash-a",
      idUser: "seller-2",
    });
  });

  it("allows a superadmin to consolidate or apply validated filters", () => {
    expect(resolveCorteScope({ uid: "root", rol: "SUPERADMIN" }, {})).toEqual({ role: "SUPERADMIN" });
    expect(resolveCorteScope(
      { uid: "root", rol: "SUPERADMIN" },
      { concesionId: "concession-a", sucursalId: "branch-a", cajaId: "cash-a", idUser: "seller-1" },
    )).toMatchObject({
      role: "SUPERADMIN",
      concesionId: "concession-a",
      sucursalId: "branch-a",
      cajaId: "cash-a",
      idUser: "seller-1",
    });
  });
});
