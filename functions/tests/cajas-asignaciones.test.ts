import { buildJornadaId } from "../src/services/asignacion-caja.service";
import {
  createCajaSchema,
  updateCajaSchema,
} from "../src/middleware/validators/caja.validator";
import { assignVendedorSchema } from "../src/middleware/validators/user-asignacion.validator";
import { upsertAsignacionesCajasSchema } from "../src/middleware/validators/asignacion-caja.validator";

describe("cajas y asignaciones validators", () => {
  it("buildJornadaId genera clave estable", () => {
    expect(buildJornadaId("2026-07-02", 5)).toBe("2026-07-02__J5");
  });

  it("createCajaSchema acepta nombre", () => {
    const parsed = createCajaSchema.parse({ nombre: "Caja 1" });
    expect(parsed.nombre).toBe("Caja 1");
  });

  it("updateCajaSchema requiere al menos un campo", () => {
    expect(() => updateCajaSchema.parse({})).toThrow();
  });

  it("assignVendedorSchema acepta sucursal y caja", () => {
    const parsed = assignVendedorSchema.parse({
      sucursalId: "s1",
      cajaId: "c1",
    });
    expect(parsed.sucursalId).toBe("s1");
  });

  it("upsertAsignacionesCajasSchema valida matriz", () => {
    const parsed = upsertAsignacionesCajasSchema.parse({
      sucursalId: "s1",
      asignaciones: [{ cajaId: "c1", vendedorUid: "u1" }],
    });
    expect(parsed.asignaciones).toHaveLength(1);
  });
});
