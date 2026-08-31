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
  VIP_ORDERS: "vip_orders",
  VIP_CONCESSION_CONFIG: "vip_concession_config",
  VIP_PRODUCT_CONFIG: "vip_product_config",
  VIP_LOCATIONS: "vip_locations",
  VIP_SERVICE_CONFIGS: "vip_service_configs",
  VIP_RESERVATIONS: "vip_reservations",
  VIP_STRIPE_EVENTS: "vip_stripe_events",
  VIP_IDEMPOTENCY: "vip_idempotency",
  VIP_REFUND_OPERATIONS: "vip_refund_operations",
  VIP_RATE_LIMITS: "vip_rate_limits",
} as const;

// Subcolecciones.
export const SUBCOLLECTIONS = {
  CAJAS: "cajas",
  PRODUCTOS: "productos",
  DETALLE: "detalle",
  MOVIMIENTOS: "movimientos",
  EVENTS: "events",
} as const;
