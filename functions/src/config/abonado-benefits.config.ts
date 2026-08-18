/**
 * Catálogo de beneficios POS para abonados (Fierabono).
 * HARDCODED: no viene de Firestore `beneficios` ni `descuentos` del POS.
 * La elegibilidad del abonado sí se lee de `usuariosApp.seasonPassVerification`.
 */
export type AbonadoBenefitType = "buy_one_get_one" | "subscriber_price";

export interface AbonadoBenefitDefinition {
  id: string;
  titulo: string;
  descripcion: string;
  tipo: AbonadoBenefitType;
  /** El nombre del producto debe contener todos estos tokens (case-insensitive). */
  productNameTokens: string[];
  /** IDs de producto opcionales (env, separados por coma). */
  productIds?: string[];
  /** IDs de concesión POS (env, separados por coma). Opcional si hay concesionNombreTokens. */
  concesionIds?: string[];
  /** Tokens del nombre de concesión (p. ej. "ice", "cervecer" → Cervecería). */
  concesionNombreTokens?: string[];
  /** Precio fijo para abonados (tipo subscriber_price). */
  subscriberPrice?: number;
  /**
   * true = un solo uso por abonado (persistido en posBeneficiosConsumidos).
   * false = beneficio permanente / reutilizable en cada venta.
   */
  onceOnly: boolean;
}

/** Beneficios de un solo uso (p. ej. ICE 2x1). */
export const isOnceOnlyBenefit = (
  benefit: AbonadoBenefitDefinition,
): boolean => benefit.onceOnly === true;

const normalizeConcesionNombre = (value?: string | null): string => {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
};

/** Indica si un beneficio aplica a la concesión del vendedor. */
export const benefitAppliesToConcesion = (
  benefit: AbonadoBenefitDefinition,
  concesionId?: string | null,
  concesionNombre?: string | null,
): boolean => {
  const trimmedId = concesionId?.trim();
  const ids = benefit.concesionIds ?? [];
  if (ids.length > 0 && trimmedId && ids.includes(trimmedId)) {
    return true;
  }

  const tokens = benefit.concesionNombreTokens ?? [];
  if (tokens.length === 0) {
    return false;
  }

  const nombreNorm = normalizeConcesionNombre(concesionNombre);
  if (!nombreNorm) {
    return false;
  }

  return tokens.every((token) =>
    nombreNorm.includes(normalizeConcesionNombre(token)),
  );
};

/** Disabled: POS QR only assigns Club León points. */
export const ABONADO_BENEFITS_CATALOG: AbonadoBenefitDefinition[] = [];

export const getBenefitDefinition = (
  benefitId: string,
): AbonadoBenefitDefinition | undefined =>
  ABONADO_BENEFITS_CATALOG.find((benefit) => benefit.id === benefitId);

export const filterBenefitsForConcesion = (
  benefits: AbonadoBenefitDefinition[],
  concesionId?: string | null,
  concesionNombre?: string | null,
): AbonadoBenefitDefinition[] =>
  benefits.filter((benefit) =>
    benefitAppliesToConcesion(benefit, concesionId, concesionNombre),
  );
