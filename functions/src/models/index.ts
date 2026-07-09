// src/models/index.ts
// Modelos centralizados del dominio.

export enum UserRole {
    SUPERADMIN = "SUPERADMIN",
    ADMIN = "ADMIN",
    VENDEDOR = "VENDEDOR",
}

export interface BaseEntity {
    id: string;
    createdAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    updatedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

export interface User extends BaseEntity {
    uid: string;
    nombre: string;
    fecha_nacimiento?: string | null;
    email: string;
    rol: UserRole;
    activo: boolean;
    /** Requerido para ADMIN y VENDEDOR. null/undefined para SUPERADMIN. */
    concesionId?: string | null;
    /** Requerido para VENDEDOR. */
    sucursalId?: string | null;
    /** Caja default del VENDEDOR dentro de su sucursal. */
    cajaId?: string | null;
}

export interface Concession extends BaseEntity {
    nombre: string;
    activo: boolean;
    imagenes: string[];
    idUser?: string | null;
}

export interface Zona extends BaseEntity {
    zona: string;
    activo: boolean;
}

export interface Caja extends BaseEntity {
    nombre: string;
    activo: boolean;
    orden?: number;
}

export interface Sucursal extends BaseEntity {
    concesion_id: string;
    zona_id: string;
    nombre: string | null;
    activo: boolean;
    cajas?: Caja[];
}

export interface Product extends BaseEntity {
    concesion_id: string;
    nombre: string;
    unidad_medida: string;
    precio: number;
    imagenes: string[];
    activo: boolean;
}

export interface JornadaActivaValue {
    activo?: boolean;
    equipo_local?: string;
    equipo_visitante?: string;
    estadio?: string;
    fecha?: string;
    hora?: string;
    jornada?: number;
    [key: string]: unknown;
}

export interface InventarioProducto extends BaseEntity {
    producto_id: string;
    cantidad_inicial?: number;
    cantidad_final?: number;
    precio_jornada?: number;
}

export type InventarioMovimientoTipo = "CARGA_INICIAL" | "AJUSTE" | "VENTA";

export interface InventarioMovimiento extends BaseEntity {
    tipo: InventarioMovimientoTipo;
    producto_id: string;
    cantidad: number;
    cantidad_anterior: number;
    cantidad_nueva: number;
    sucursal_id?: string | null;
    cajaId?: string | null;
    cajaNombre?: string | null;
    idUser?: string | null;
    ventaId?: string | null;
}

export interface Inventario extends BaseEntity {
    jornada_fecha: string;
    jornada_numero: number;
    /** Legacy: inventarios viejos por sucursal. Nuevos son por concesión. */
    sucursal_id?: string | null;
    concesion_id: string;
    activo: boolean;
    productos?: InventarioProducto[];
}

export interface DetalleProducto {
    producto: string;
    cantidad: number;
    precio_actual: number;
    subtotal?: number;
}

export interface ComprobanteVenta extends BaseEntity {
    ventaId: string;
    concesionId: string;
    sucursalId: string;
    inventarioId: string;
    jornadaId?: string | null;
    cajaId?: string | null;
    cajaNombre?: string | null;
    idUser?: string | null;
    cajeroNombre?: string | null;
    total: number;
    fecha?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    detalle?: DetalleProducto[];
}

export interface AsignacionCajaJornada extends BaseEntity {
    jornadaId: string;
    concesionId: string;
    sucursalId: string;
    cajaId: string;
    cajaNombre: string;
    vendedorUid: string;
    vendedorNombre: string;
    activo: boolean;
}

export interface Ticket extends BaseEntity {
    fecha: string;
    metodo_pago: string;
    subtotal: number;
    total: number;
    status: string;
    concesionId: string;
    sucursalId?: string | null;
    idUser?: string | null;
}

export interface ComboProducto {
    producto_id: string;
    cantidad: number;
}

export interface Combo extends BaseEntity {
    concesion_id: string;
    titulo: string;
    descripcion?: string | null;
    productos: ComboProducto[];
    /** Precio de venta del combo. */
    precio: number;
    activo: boolean;
    /** Persona que creó el combo. */
    createdByUid?: string | null;
    createdByNombre?: string | null;
}

export type DescuentoTipo = "2X1" | "3X2" | "PORCENTAJE" | "MONTO";

export interface Descuento extends BaseEntity {
    concesion_id: string;
    titulo: string;
    descripcion?: string | null;
    tipo: DescuentoTipo;
    /** Porcentaje (1-100) o monto fijo. null para promos tipo 2X1/3X2. */
    valor?: number | null;
    /** Productos de la concesión a los que aplica la promoción. */
    producto_ids: string[];
    activo: boolean;
    createdByUid?: string | null;
    createdByNombre?: string | null;
}

export interface Corte extends BaseEntity {
    ventaId: string | null;
    idUser: string | null;
    concesionId: string;
    sucursalId?: string | null;
    fecha: string;
    comentarios: string | null;
    estatus: string;
    totalReal: number;
    totalCaja: number;
    totalEfectivo?: number | null;
    totalTarjeta?: number | null;
}
