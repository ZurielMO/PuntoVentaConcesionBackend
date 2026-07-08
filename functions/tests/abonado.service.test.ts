import {
  ABONADO_BENEFITS_CATALOG,
  ABONADO_BENEFIT_ONCE_PER_VENTA,
  getBenefitDefinition,
} from "../src/config/abonado-benefits.config";

describe("abonado-benefits.config", () => {
  it("incluye ICE 2x1 hardcodeado", () => {
    expect(ABONADO_BENEFITS_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ice-2x1",
          titulo: "ICE 2x1",
          tipo: "buy_one_get_one",
          productNameTokens: ["ice", "grande"],
        }),
      ]),
    );
  });

  it("getBenefitDefinition resuelve por id", () => {
    expect(getBenefitDefinition("ice-2x1")?.titulo).toBe("ICE 2x1");
    expect(getBenefitDefinition("no-existe")).toBeUndefined();
  });

  it("ABONADO_BENEFIT_ONCE_PER_VENTA es false por defecto en tests", () => {
    expect(ABONADO_BENEFIT_ONCE_PER_VENTA).toBe(false);
  });
});
