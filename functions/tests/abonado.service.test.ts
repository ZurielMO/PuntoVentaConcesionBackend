import {
  ABONADO_BENEFITS_CATALOG,
  benefitAppliesToConcesion,
  filterBenefitsForConcesion,
  getBenefitDefinition,
  isOnceOnlyBenefit,
} from "../src/config/abonado-benefits.config";

describe("abonado-benefits.config", () => {
  it("incluye ICE 2x1 hardcodeado como once-only", () => {
    expect(ABONADO_BENEFITS_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ice-2x1",
          titulo: "ICE 2x1",
          tipo: "buy_one_get_one",
          onceOnly: true,
          productNameTokens: ["ice", "grande"],
        }),
      ]),
    );
  });

  it("incluye precio abonado cerveza como permanente", () => {
    expect(ABONADO_BENEFITS_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cerveza-precio-abonado",
          tipo: "subscriber_price",
          onceOnly: false,
          subscriberPrice: 90,
          productNameTokens: ["cerveza"],
        }),
      ]),
    );
  });

  it("getBenefitDefinition resuelve por id", () => {
    expect(getBenefitDefinition("ice-2x1")?.titulo).toBe("ICE 2x1");
    expect(getBenefitDefinition("no-existe")).toBeUndefined();
  });

  it("isOnceOnlyBenefit solo aplica a ICE 2x1", () => {
    const ice = getBenefitDefinition("ice-2x1")!;
    const cerveza = getBenefitDefinition("cerveza-precio-abonado")!;
    expect(isOnceOnlyBenefit(ice)).toBe(true);
    expect(isOnceOnlyBenefit(cerveza)).toBe(false);
  });

  it("filtra beneficios por nombre de concesión", () => {
    const ice = getBenefitDefinition("ice-2x1")!;
    const cerveza = getBenefitDefinition("cerveza-precio-abonado")!;

    expect(benefitAppliesToConcesion(ice, null, "ICE")).toBe(true);
    expect(benefitAppliesToConcesion(ice, null, "Cervecería")).toBe(false);
    expect(benefitAppliesToConcesion(cerveza, null, "Cervecería")).toBe(true);
    expect(benefitAppliesToConcesion(cerveza, null, "ICE")).toBe(false);
  });

  it("filterBenefitsForConcesion devuelve solo beneficios de la concesión", () => {
    const cerveceria = filterBenefitsForConcesion(
      ABONADO_BENEFITS_CATALOG,
      "concesion-cerveza",
      "Cervecería",
    );
    expect(cerveceria.map((b) => b.id)).toEqual(["cerveza-precio-abonado"]);

    const ice = filterBenefitsForConcesion(
      ABONADO_BENEFITS_CATALOG,
      "concesion-ice",
      "ICE",
    );
    expect(ice.map((b) => b.id)).toEqual(["ice-2x1"]);
  });
});
