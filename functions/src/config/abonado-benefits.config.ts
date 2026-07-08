/**
 * Catálogo de beneficios POS para abonados (Fierabono).
 * HARDCODED: no viene de Firestore `beneficios` ni `descuentos` del POS.
 * La elegibilidad del abonado sí se lee de `usuariosApp.seasonPassVerification`.
 */
export type AbonadoBenefitType = "buy_one_get_one";

export interface AbonadoBenefitDefinition {
  id: string;
  titulo: string;
  descripcion: string;
  tipo: AbonadoBenefitType;
  /** El nombre del producto debe contener todos estos tokens (case-insensitive). */
  productNameTokens: string[];
  /** IDs de producto opcionales (env ABONADO_ICE_PRODUCT_IDS, separados por coma). */
  productIds?: string[];
}

/**
 * TEMP: revert to once per jornada after testing.
 * When true, GET always marks benefits disponible and POST consumir does not persist
 * posBeneficiosConsumidos (benefit reusable on each new venta scan).
 */
export const ABONADO_BENEFIT_ONCE_PER_VENTA =
  process.env.ABONADO_BENEFIT_ONCE_PER_VENTA === "true";

const parseProductIds = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

export const ABONADO_BENEFITS_CATALOG: AbonadoBenefitDefinition[] = [
  {
    id: "ice-2x1",
    titulo: "ICE 2x1",
    descripcion: "Compra 1 ICE Grande y lleva otro gratis",
    tipo: "buy_one_get_one",
    productNameTokens: ["ice", "grande"],
    productIds: parseProductIds(process.env.ABONADO_ICE_PRODUCT_IDS),
  },
];

export const getBenefitDefinition = (
  benefitId: string,
): AbonadoBenefitDefinition | undefined =>
  ABONADO_BENEFITS_CATALOG.find((benefit) => benefit.id === benefitId);
