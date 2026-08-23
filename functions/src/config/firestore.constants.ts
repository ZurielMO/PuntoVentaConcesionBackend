// Id de la base de datos Firestore del PROYECTO BASE (POS Concesiones).
// El proyecto `puntoventacl` usa una base de datos NOMBRADA "concesiones"
// (no la "(default)"). Puede sobreescribirse con FIRESTORE_DATABASE_ID.
export const STORE_FIRESTORE_DATABASE = "concesiones";

// Nombres de colecciones del proyecto POS.
export const COLLECTIONS = {
  CONCESIONES: "concesiones",
  SUCURSALES: "sucursales",
  ZONAS: "zonas",
  PRODUCTS: "products",
  INVENTARIOS: "inventarios",
  USERS: "users",
  TICKETS: "tickets",
  CORTES: "cortes",
  COMPROBANTES_VENTA: "comprobantes_venta",
  ASIGNACIONES_CAJAS_JORNADA: "asignaciones_cajas_jornada",
  COMBOS: "combos",
  DESCUENTOS: "descuentos",
  ABONADO_BENEFICIOS_CONSUMIDOS: "abonado_beneficios_consumidos",
  CINEPOLIS_ASIGNACIONES: "cinepolis_asignaciones",
  /**
   * Acumulaciones de puntos que no alcanzaron el ledger de Club León y esperan
   * reproceso. Vive en la base del POS a propósito: debe poder escribirse
   * aunque la integración con app-oficial esté caída.
   */
  LOYALTY_OPERACIONES_PENDIENTES: "loyalty_operaciones_pendientes",
} as const;

// Subcolecciones.
export const SUBCOLLECTIONS = {
  CAJAS: "cajas",
  PRODUCTOS: "productos",
  DETALLE: "detalle",
  MOVIMIENTOS: "movimientos",
} as const;
