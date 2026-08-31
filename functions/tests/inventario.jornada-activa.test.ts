import {
  buildInventarioId,
  normalizeFecha,
} from "../src/services/inventario.service";
import {
  buildJornadaId,
  parseJornadaId,
  normalizeRama,
} from "../src/services/asignacion-caja.service";

describe("inventario jornada activa — IDs", () => {
  it("buildInventarioId varonil (sin sufijo)", () => {
    expect(buildInventarioId("2026-07-17", 1, "conc-abc")).toBe(
      "2026-07-17__J1__conc-abc",
    );
  });

  it("buildInventarioId femenil incluye sufijo", () => {
    expect(buildInventarioId("2026-09-07", 6, "suc-1", "femenil")).toBe(
      "2026-09-07__J6__femenil__suc-1",
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

describe("jornadaId con rama", () => {
  it("buildJornadaId varonil sin sufijo", () => {
    expect(buildJornadaId("2026-09-07", 6)).toBe("2026-09-07__J6");
  });

  it("buildJornadaId femenil con sufijo", () => {
    expect(buildJornadaId("2026-09-07", 6, "femenil")).toBe(
      "2026-09-07__J6__femenil",
    );
  });

  it("parseJornadaId soporta ambos formatos", () => {
    expect(parseJornadaId("2026-09-07__J6")).toEqual({
      fecha: "2026-09-07",
      numero: 6,
      rama: "varonil",
    });
    expect(parseJornadaId("2026-09-07__J6__femenil")).toEqual({
      fecha: "2026-09-07",
      numero: 6,
      rama: "femenil",
    });
  });

  it("normalizeRama trata legacy como varonil", () => {
    expect(normalizeRama(undefined)).toBe("varonil");
    expect(normalizeRama("femenil")).toBe("femenil");
  });
});

describe("resolveJornadaActiva", () => {
  const mockRef = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    mockRef.mockReset();
    jest.doMock("../src/config/firebase.appoficial2", () => ({
      getRealtimeDbAppOficial2: () => ({
        ref: (path: string) => ({
          get: () => mockRef(path),
        }),
      }),
    }));
  });

  it("lanza JORNADA_NO_ACTIVA sin jornadas en la rama", async () => {
    mockRef.mockResolvedValue({ exists: () => false, val: () => null });
    const { resolveJornadaActiva } = await import(
      "../src/services/jornada.service"
    );
    await expect(resolveJornadaActiva("femenil")).rejects.toMatchObject({
      code: "JORNADA_NO_ACTIVA",
    });
  });

  it("resuelve jornada femenil desde jornada_activa_femenil", async () => {
    mockRef.mockImplementation(async (path: string) => {
      if (path === "jornada_activa_femenil") {
        return {
          exists: () => true,
          val: () => ({
            Jornada6: {
              activo: true,
              jornada: 6,
              fecha: "07/09/2026",
              equipo_local: "León",
              equipo_visitante: "Puebla",
              rama: "femenil",
            },
          }),
        };
      }
      return { exists: () => false, val: () => null };
    });

    const { resolveJornadaActiva } = await import(
      "../src/services/jornada.service"
    );
    const result = await resolveJornadaActiva("femenil");
    expect(result.jornadaNumero).toBe(6);
    expect(result.fecha).toBe("2026-09-07");
    expect(result.rama).toBe("femenil");
    expect(result.detalle.equipo_visitante).toBe("Puebla");
  });

  it("resuelve varonil sin mezclar con femenil", async () => {
    mockRef.mockImplementation(async (path: string) => {
      if (path === "jornada_activa") {
        return {
          exists: () => true,
          val: () => ({
            j11: {
              activo: true,
              jornada: 11,
              fecha: "14/03/2026",
              equipo_local: "Local",
            },
          }),
        };
      }
      if (path === "jornada_activa_femenil") {
        return {
          exists: () => true,
          val: () => ({
            Jornada6: {
              activo: true,
              jornada: 6,
              fecha: "07/09/2026",
            },
          }),
        };
      }
      return { exists: () => false, val: () => null };
    });

    const { resolveJornadaActiva, resolveJornadaPrimaria } = await import(
      "../src/services/jornada.service"
    );
    const varonil = await resolveJornadaActiva("varonil");
    expect(varonil.jornadaNumero).toBe(11);
    expect(varonil.rama).toBe("varonil");

    const primaria = await resolveJornadaPrimaria();
    expect(primaria.jornadaNumero).toBe(11);

    const femenil = await resolveJornadaActiva("femenil");
    expect(femenil.jornadaNumero).toBe(6);
    expect(femenil.rama).toBe("femenil");
  });
});

describe("listJornadasDisponibles — histórico", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  const mockEmptyRtdb = () => {
    jest.doMock("../src/config/firebase.appoficial2", () => ({
      getRealtimeDbAppOficial2: () => ({
        ref: () => ({
          get: async () => ({ exists: () => false, val: () => null }),
        }),
      }),
    }));
  };

  it("incluye inventarios cerrados y distingue ramas", async () => {
    mockEmptyRtdb();
    const docs = [
      {
        data: () => ({
          jornada_fecha: "2026-09-07",
          jornada_numero: 6,
          rama: "femenil",
          activo: true,
          sucursal_id: "s1",
          concesion_id: "c1",
        }),
      },
      {
        data: () => ({
          jornada_fecha: "2026-08-01",
          jornada_numero: 3,
          activo: false,
          sucursal_id: "s1",
          concesion_id: "c1",
        }),
      },
      {
        data: () => ({
          jornada_fecha: "2026-09-07",
          jornada_numero: 6,
          rama: "varonil",
          activo: false,
          sucursal_id: "s1",
          concesion_id: "c1",
        }),
      },
    ];

    jest.doMock("../src/config/firebase", () => ({
      firestorePos: {
        collection: () => ({
          where: () => ({
            get: async () => ({ docs }),
          }),
          get: async () => ({ docs }),
        }),
      },
    }));

    const { listJornadasDisponibles } = await import(
      "../src/services/jornada.service"
    );
    const list = await listJornadasDisponibles();
    expect(list).toHaveLength(3);
    expect(list.map((j) => j.jornadaId).sort()).toEqual(
      [
        "2026-08-01__J3",
        "2026-09-07__J6",
        "2026-09-07__J6__femenil",
      ].sort(),
    );
    const fem = list.find((j) => j.rama === "femenil");
    expect(fem?.etiqueta).toContain("Femenil");
  });

  it("elimina varonil fantasma cuando legacy sin rama coincide con femenil", async () => {
    jest.doMock("../src/config/firebase.appoficial2", () => ({
      getRealtimeDbAppOficial2: () => ({
        ref: (path: string) => ({
          get: async () => {
            if (path === "jornada_activa_femenil") {
              return {
                exists: () => true,
                val: () => ({
                  Jornada6: {
                    activo: true,
                    jornada: 6,
                    fecha: "07/09/2026",
                    equipo_local: "León",
                    equipo_visitante: "Puebla",
                  },
                }),
              };
            }
            return { exists: () => false, val: () => null };
          },
        }),
      }),
    }));

    const docs = [
      {
        data: () => ({
          jornada_fecha: "2026-09-07",
          jornada_numero: 6,
          rama: "femenil",
          activo: true,
          sucursal_id: "s1",
          concesion_id: "c1",
        }),
      },
      {
        data: () => ({
          // Legacy sin rama → antes se listaba como varonil fantasma
          jornada_fecha: "2026-09-07",
          jornada_numero: 6,
          activo: true,
          sucursal_id: "s2",
          concesion_id: "c1",
        }),
      },
    ];

    jest.doMock("../src/config/firebase", () => ({
      firestorePos: {
        collection: () => ({
          where: () => ({
            get: async () => ({ docs }),
          }),
          get: async () => ({ docs }),
        }),
      },
    }));

    const { listJornadasDisponibles } = await import(
      "../src/services/jornada.service"
    );
    const list = await listJornadasDisponibles();
    expect(list.map((j) => j.jornadaId)).toEqual(["2026-09-07__J6__femenil"]);
    expect(list[0].rama).toBe("femenil");
  });
});
