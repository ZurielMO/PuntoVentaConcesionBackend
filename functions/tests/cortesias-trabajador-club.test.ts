import {
  buildCortesiaDocId,
  normalizeFechaPartido,
} from "../src/services/cortesias-trabajador-club.service";

describe("cortesias trabajador club helpers", () => {
  it("normalizeFechaPartido acepta DD/MM/YYYY", () => {
    expect(normalizeFechaPartido("17/07/2026")).toBe("2026-07-17");
  });

  it("buildCortesiaDocId genera id estable", () => {
    expect(buildCortesiaDocId("Apertura 2026", 11)).toBe("apertura_2026__J11");
  });
});

describe("isLeonLocalTeam filter", () => {
  const isLeon = (name: string) =>
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .includes("leon");

  it("detecta León con y sin acento", () => {
    expect(isLeon("Club León")).toBe(true);
    expect(isLeon("Leon")).toBe(true);
    expect(isLeon("América")).toBe(false);
  });
});
