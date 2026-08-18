import {
  createConcessionSchema,
  replaceConcessionSchema,
} from "../src/middleware/validators/concession.validator";

describe("createConcessionSchema", () => {
  it("acepta el payload del asistente de alta (tipo + comisión)", () => {
    const parsed = createConcessionSchema.parse({
      nombre: "Taquería León",
      activo: true,
      imagenes: [],
      porcentajeComision: 10,
      tipo: "GENERAL",
    });

    expect(parsed.tipo).toBe("GENERAL");
    expect(parsed.porcentajeComision).toBe(10);
  });

  it("rechaza un tipo desconocido", () => {
    expect(() =>
      createConcessionSchema.parse({
        nombre: "Demo",
        tipo: "OTRO",
      }),
    ).toThrow();
  });
});

describe("replaceConcessionSchema", () => {
  it("no fuerza imagenes a [] cuando se omite (reactivar / editar nombre)", () => {
    const parsed = replaceConcessionSchema.parse({
      nombre: "Concesión Demo",
      activo: true,
    });

    expect(parsed.imagenes).toBeUndefined();
    expect(parsed.activo).toBe(true);
  });

  it("acepta imagenes explícitas, incluido [] para limpiar logo", () => {
    const withImages = replaceConcessionSchema.parse({
      nombre: "Concesión Demo",
      imagenes: ["https://example.com/logo.png"],
    });
    expect(withImages.imagenes).toEqual(["https://example.com/logo.png"]);

    const cleared = replaceConcessionSchema.parse({
      nombre: "Concesión Demo",
      imagenes: [],
    });
    expect(cleared.imagenes).toEqual([]);
  });
});
