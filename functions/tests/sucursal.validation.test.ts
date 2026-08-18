import { createSucursalSchema } from "../src/middleware/validators/sucursal.validator";

describe("createSucursalSchema", () => {
  it("acepta modo_operacion del asistente de alta", () => {
    const parsed = createSucursalSchema.parse({
      sucursal: { nombre: "Punto Norte", modo_operacion: "POS" },
    });

    expect(parsed.sucursal.nombre).toBe("Punto Norte");
    expect(parsed.sucursal.modo_operacion).toBe("POS");
  });

  it("acepta corte por conteo", () => {
    const parsed = createSucursalSchema.parse({
      sucursal: { nombre: "Cervecería", modo_operacion: "CONTEO" },
    });

    expect(parsed.sucursal.modo_operacion).toBe("CONTEO");
  });
});
