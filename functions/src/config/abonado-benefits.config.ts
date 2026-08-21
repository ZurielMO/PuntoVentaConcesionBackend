/**
 * Beneficios POS para abonados (Fierabono).
 * La oferta sale de Firestore `descuentos` (activos, por concesión y producto).
 * La elegibilidad del abonado se lee de `usuariosApp.seasonPassVerification`.
 */

export type AbonadoBenefitType = "2X1" | "3X2" | "PORCENTAJE" | "MONTO";

export interface AbonadoBenefitDefinition {
  id: string;
  titulo: string;
  descripcion: string;
  tipo: AbonadoBenefitType;
  productIds: string[];
  concesionIds: string[];
  valor?: number | null;
}

const DESCUENTO_TIPOS: AbonadoBenefitType[] = [
  "2X1",
  "3X2",
  "PORCENTAJE",
  "MONTO",
];

const asStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ];
};

export const isAbonadoBenefitType = (
  value: string,
): value is AbonadoBenefitType =>
  DESCUENTO_TIPOS.includes(value as AbonadoBenefitType);

export const isQuantityPromo = (tipo: AbonadoBenefitType): boolean =>
  tipo === "2X1" || tipo === "3X2";

/** Mapea un documento de `descuentos` a beneficio de abonado. */
export const mapDescuentoToBenefit = (
  row: Record<string, unknown> & { id: string },
): AbonadoBenefitDefinition | null => {
  if (row.activo === false) return null;

  const tipo = String(row.tipo ?? "").toUpperCase();
  if (!isAbonadoBenefitType(tipo)) return null;

  const productIds = asStringList(row.producto_ids);
  if (productIds.length === 0) return null;

  const concesionId = String(row.concesion_id ?? "").trim();
  const valorRaw = row.valor;
  const valor =
    typeof valorRaw === "number" && Number.isFinite(valorRaw) ? valorRaw : null;

  return {
    id: row.id,
    titulo: String(row.titulo ?? "Descuento").trim() || "Descuento",
    descripcion: String(row.descripcion ?? "").trim(),
    tipo,
    productIds,
    concesionIds: concesionId ? [concesionId] : [],
    valor: tipo === "PORCENTAJE" || tipo === "MONTO" ? valor : null,
  };
};
