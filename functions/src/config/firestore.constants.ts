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
} as const;

// Subcolecciones.
export const SUBCOLLECTIONS = {
  CAJAS: "cajas",
  PRODUCTOS: "productos",
  DETALLE: "detalle",
} as const;
