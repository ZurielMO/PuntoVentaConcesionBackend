import {
  buildInventarioId,
  normalizeFecha,
} from "../src/services/inventario.service";

describe("inventario jornada activa — IDs", () => {
  it("buildInventarioId usa concesionId en el ID compuesto", () => {
    expect(buildInventarioId("2026-07-17", 1, "conc-abc")).toBe(
      "2026-07-17__J1__conc-abc",
    );
  });

  it("normalizeFecha acepta DD/MM/YYYY", () => {
    expect(normalizeFecha("17/07/2026")).toBe("2026-07-17");
  });

  it("nuevo ID termina en concesionId, no en sucursalId legacy", () => {
    const nuevo = buildInventarioId("2026-07-17", 1, "concesionXYZ");
    const legacy = "2026-07-17__J1__ihtls10eLXXD5I2htMF1";
    expect(nuevo).not.toBe(legacy);
    expect(nuevo.endsWith("concesionXYZ")).toBe(true);
  });
});

describe("resolveJornadaPrimaria", () => {
  const mockRefGet = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    mockRefGet.mockReset();
    jest.doMock("../src/config/firebase.appoficial2", () => ({
      getRealtimeDbAppOficial2: () => ({
        ref: () => ({ get: mockRefGet }),
      }),
    }));
  });

  it("lanza JORNADA_NO_ACTIVA sin jornadas", async () => {
    mockRefGet.mockResolvedValue({ exists: () => false, val: () => null });
    const { resolveJornadaPrimaria } = await import("../src/services/jornada.service");
    await expect(resolveJornadaPrimaria()).rejects.toMatchObject({
      code: "JORNADA_NO_ACTIVA",
    });
  });

  it("devuelve número y fecha normalizada", async () => {
    mockRefGet.mockResolvedValue({
      exists: () => true,
      val: () => ({
        j11: {
          activo: true,
          jornada: 11,
          fecha: "14/03/2026",
          equipo_local: "Local",
          equipo_visitante: "Visitante",
        },
      }),
    });
    const { resolveJornadaPrimaria } = await import("../src/services/jornada.service");
    const result = await resolveJornadaPrimaria();
    expect(result.jornadaNumero).toBe(11);
    expect(result.fecha).toBe("2026-03-14");
    expect(result.detalle.equipo_local).toBe("Local");
  });
});
