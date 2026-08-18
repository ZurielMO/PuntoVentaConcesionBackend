/**
 * Reglas de consumo de inventario entre productos (BOM ligero).
 * Ejemplo cervecería: vender 1 "Vaso de Cerveza" descuenta 2 "Pieza Cerveza".
 *
 * Matching por tokens de nombre (y opcionalmente IDs vía env), acotado a
 * concesiones cuyo nombre contiene "cervecer" — mismo criterio que abonado cerveza.
 */

export interface InventoryConsumptionRule {
  id: string;
  /** Tokens del nombre de concesión (p. ej. "cervecer" → Cervecería). */
  concesionNombreTokens: string[];
  /** IDs de concesión opcionales (env, separados por coma). */
  concesionIds?: string[];
  /** Producto vendido que dispara el consumo extra. */
  triggerProductNameTokens: string[];
  triggerProductIds?: string[];
  /** Producto cuyo stock se descuenta adicionalmente. */
  consumeProductNameTokens: string[];
  /**
   * Alias de tokens (OR): p. ej. "Cerveza unidad" además de "Pieza Cerveza".
   * Cada entrada es un AND de tokens, igual que consumeProductNameTokens.
   */
  consumeProductNameTokenAliases?: string[][];
  consumeProductIds?: string[];
  /** Unidades del producto de consumo por cada unidad vendida del trigger. */
  consumeQtyPerUnit: number;
}

export interface CatalogProductRef {
  id: string;
  nombre?: string | null;
}

export interface InventoryDraw {
  producto: string;
  cantidad: number;
}

const parseCsv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

export const normalizeNombre = (value?: string | null): string => {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
};

export const productMatchesTokens = (
  productId: string | null | undefined,
  productNombre: string | null | undefined,
  nameTokens: string[],
  productIds?: string[],
): boolean => {
  const ids = productIds ?? [];
  const trimmedId = productId?.trim();
  if (ids.length > 0 && trimmedId && ids.includes(trimmedId)) {
    return true;
  }

  if (nameTokens.length === 0) {
    return false;
  }

  const nombreNorm = normalizeNombre(productNombre);
  if (!nombreNorm) {
    return false;
  }

  return nameTokens.every((token) =>
    nombreNorm.includes(normalizeNombre(token)),
  );
};

export const ruleAppliesToConcesion = (
  rule: InventoryConsumptionRule,
  concesionId?: string | null,
  concesionNombre?: string | null,
): boolean => {
  const trimmedId = concesionId?.trim();
  const ids = rule.concesionIds ?? [];
  if (ids.length > 0 && trimmedId && ids.includes(trimmedId)) {
    return true;
  }

  const tokens = rule.concesionNombreTokens ?? [];
  if (tokens.length === 0) {
    return false;
  }

  const nombreNorm = normalizeNombre(concesionNombre);
  if (!nombreNorm) {
    return false;
  }

  return tokens.every((token) => nombreNorm.includes(normalizeNombre(token)));
};

export const findProductMatching = (
  products: CatalogProductRef[],
  nameTokens: string[],
  productIds?: string[],
  nameTokenAliases?: string[][],
): CatalogProductRef | undefined => {
  const tokenSets = [nameTokens, ...(nameTokenAliases ?? [])].filter(
    (tokens) => tokens.length > 0,
  );
  for (const tokens of tokenSets) {
    const found = products.find((product) =>
      productMatchesTokens(product.id, product.nombre, tokens, productIds),
    );
    if (found) return found;
  }
  return undefined;
};

export const INVENTORY_CONSUMPTION_RULES: InventoryConsumptionRule[] = [
  {
    id: "vaso-cerveza-consume-piezas",
    concesionIds: parseCsv(process.env.CERVEZA_VASO_CONCESION_IDS),
    concesionNombreTokens: ["cervecer"],
    triggerProductNameTokens: ["vaso", "cerveza"],
    triggerProductIds: parseCsv(process.env.CERVEZA_VASO_PRODUCT_IDS),
    // Catálogo histórico: "Pieza Cerveza". Producción: "Cerveza unidad".
    consumeProductNameTokens: ["pieza", "cerveza"],
    consumeProductNameTokenAliases: [["unidad", "cerveza"]],
    consumeProductIds: parseCsv(process.env.CERVEZA_PIEZA_PRODUCT_IDS),
    consumeQtyPerUnit: Number(process.env.CERVEZA_VASO_PIEZAS_PER_VASO ?? 2),
  },
];

/**
 * Une draws por producto sumando cantidades.
 */
export const mergeInventoryDraws = (
  draws: InventoryDraw[],
): InventoryDraw[] => {
  const byProduct = new Map<string, number>();
  for (const draw of draws) {
    if (!draw.producto || draw.cantidad <= 0) continue;
    byProduct.set(
      draw.producto,
      (byProduct.get(draw.producto) ?? 0) + draw.cantidad,
    );
  }
  return Array.from(byProduct.entries()).map(([producto, cantidad]) => ({
    producto,
    cantidad,
  }));
};

/**
 * A partir de líneas de venta (ya resueltas / expandido combo), construye
 * los descuentos de inventario: cada línea descuenta su propio SKU, más
 * consumos configurados (p. ej. vaso → +2 piezas).
 *
 * No modifica las líneas de venta del ticket — solo el mapa de stock.
 */
export const expandInventoryConsumptionDraws = (params: {
  lineas: Array<{ producto: string; cantidad: number }>;
  catalogProducts: CatalogProductRef[];
  concesionId?: string | null;
  concesionNombre?: string | null;
}): InventoryDraw[] => {
  const base: InventoryDraw[] = params.lineas.map((linea) => ({
    producto: linea.producto,
    cantidad: linea.cantidad,
  }));

  const extras: InventoryDraw[] = [];
  const byId = new Map(
    params.catalogProducts.map((product) => [product.id, product]),
  );

  for (const rule of INVENTORY_CONSUMPTION_RULES) {
    if (
      !ruleAppliesToConcesion(
        rule,
        params.concesionId,
        params.concesionNombre,
      )
    ) {
      continue;
    }

    const qtyPerUnit = Number(rule.consumeQtyPerUnit);
    if (!Number.isFinite(qtyPerUnit) || qtyPerUnit <= 0) {
      continue;
    }

    let consumeProduct: CatalogProductRef | undefined;

    for (const linea of params.lineas) {
      const sold = byId.get(linea.producto);
      const matches = productMatchesTokens(
        linea.producto,
        sold?.nombre,
        rule.triggerProductNameTokens,
        rule.triggerProductIds,
      );
      if (!matches) {
        continue;
      }

      if (!consumeProduct) {
        consumeProduct = findProductMatching(
          params.catalogProducts,
          rule.consumeProductNameTokens,
          rule.consumeProductIds,
          rule.consumeProductNameTokenAliases,
        );
      }

      if (!consumeProduct) {
        const triggerLabel = sold?.nombre?.trim() || linea.producto;
        throw new Error(
          `CONSUMPTION_PRODUCT_NOT_FOUND:${triggerLabel}:${rule.consumeProductNameTokens.join("+")}`,
        );
      }

      if (consumeProduct.id === linea.producto) {
        continue;
      }

      extras.push({
        producto: consumeProduct.id,
        cantidad: linea.cantidad * qtyPerUnit,
      });
    }
  }

  return mergeInventoryDraws([...base, ...extras]);
};
