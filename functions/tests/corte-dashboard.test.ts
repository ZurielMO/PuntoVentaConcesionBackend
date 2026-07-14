import { calcularComprobantes } from "../src/domain/cortes/corte-calculator";
import { buildDashboardPayload } from "../src/services/corte.service";

describe("buildDashboardPayload", () => {
  it("returns all dashboard metrics from one central calculation", () => {
    const calculation = calcularComprobantes([
      { id: "cash", total: 100, metodoPago: "efectivo", fecha: "2026-07-13T10:10:00-06:00" },
      { id: "card", total: 50, metodoPago: "tarjeta", fecha: "2026-07-13T11:10:00-06:00" },
    ], { porcentajeComision: 10 });
    const dashboard = buildDashboardPayload(
      { role: "ADMIN", concesionId: "concession-a" },
      calculation,
      [{ id: "cut-1", estatus: "CERRADO" }],
      { jornadaId: "2026-07-13__J1", businessDate: "2026-07-13" },
    );

    expect(dashboard).toMatchObject({
      contexto: { role: "ADMIN", concesionId: "concession-a" },
      ventasNetas: 150,
      dineroReal: 150,
      efectivo: 100,
      tarjeta: 50,
      puntos: 0,
      tickets: 2,
      ticketPromedio: 75,
      comision: { importeComision: 15 },
      cortesRecientes: [{ id: "cut-1", estatus: "CERRADO" }],
      jornadaId: "2026-07-13__J1",
      businessDate: "2026-07-13",
    });
    expect(dashboard).toHaveProperty("abonados");
    expect(dashboard).toHaveProperty("promociones");
    expect(dashboard).toHaveProperty("combos");
    expect(dashboard).toHaveProperty("cortesias");
    expect(dashboard).toHaveProperty("merma");
    expect(dashboard).toHaveProperty("cancelaciones");
    expect(dashboard).toHaveProperty("reembolsos");
    expect(dashboard).toHaveProperty("inventario");
    expect(dashboard).toHaveProperty("incidencias");
    expect(dashboard).toHaveProperty("ventasPorHora");
    expect(dashboard).toHaveProperty("metodosPago");
    expect(dashboard).toHaveProperty("productosPrincipales");
  });
});
