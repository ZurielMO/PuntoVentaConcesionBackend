import {
  ABONADO_BENEFITS_CATALOG,
  getBenefitDefinition,
} from "../src/config/abonado-benefits.config";

describe("abonado-benefits.config", () => {
  it("no expone beneficios; el QR solo asigna puntos", () => {
    expect(ABONADO_BENEFITS_CATALOG).toEqual([]);
    expect(getBenefitDefinition("ice-2x1")).toBeUndefined();
    expect(getBenefitDefinition("cerveza-precio-abonado")).toBeUndefined();
    expect(getBenefitDefinition("papas-2x1")).toBeUndefined();
  });
});
