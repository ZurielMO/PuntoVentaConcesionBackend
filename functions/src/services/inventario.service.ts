import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { isAppOficial2Configured } from "../config/firebase.appoficial2";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { InventarioMovimientoTipo } from "../models";
import {
  normalizeRama,
  ramaFromInventario,
  type JornadaRama,
} from "./asignacion-caja.service";
import {
  JornadaActivaValue,
  resolveJornadaActiva,
} from "./jornada.service";

const col = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

/** Normaliza fecha a YYYY-MM-DD (acepta YYYY-MM-DD o DD/MM/YYYY). */
export const normalizeFecha = (fecha: string): string => {
  const raw = decodeURIComponent(fecha).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  }
  throw new ApiError(
    400,
    "Formato de fecha inválido (usa YYYY-MM-DD o DD/MM/YYYY)",
    true,
    "INVALID_DATE",
  );
};

/**
 * ID compuesto por sucursal.
 * Varonil: `2026-03-14__J11__sucursalId`
 * Femenil: `2026-03-14__J11__femenil__sucursalId`
 */
export const buildInventarioId = (
  fecha: string,
  jornadaNumero: string | number,
  sucursalId: string,
  rama: JornadaRama | string | null | undefined = "varonil",
): string => {
  const r = normalizeRama(rama);
  const base = `${normalizeFecha(fecha)}__J${jornadaNumero}`;
  return r === "femenil"
    ? `${base}__femenil__${sucursalId}`
    : `${base}__${sucursalId}`;
};

const productosCol = (inventarioId: string) =>
  col().doc(inventarioId).collection(SUBCOLLECTIONS.PRODUCTOS);

const movimientosCol = (inventarioId: string) =>
  col().doc(inventarioId).collection(SUBCOLLECTIONS.MOVIMIENTOS);

export interface LogMovimientoInput {
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
  motivo?: string | null;
}

export const logMovimiento = async (
  inventarioId: string,
  payload: LogMovimientoInput,
) => {
  const ref = movimientosCol(inventarioId).doc();
  await ref.set({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id, ...payload };
};

export const listMovimientos = async (inventarioId: string, limit = 100) => {
  const doc = await col().doc(inventarioId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const snap = await movimientosCol(inventarioId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map(toData);
};

const getSucursalOrThrow = async (sucursalId: string) => {
  const doc = await firestorePos.collection(COLLECTIONS.SUCURSALES).doc(sucursalId).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  const concesionId = doc.data()?.concesion_id as string | undefined;
  if (!concesionId) {
    throw new ApiError(400, "Sucursal sin concesión asignada", true, "BAD_REQUEST");
  }
  return { id: doc.id, concesionId };
};

export const createInventarioPorSucursal = async (
  jornadaNumero: string | number,
  fechaJornada: string,
  sucursalId: string,
  ramaInput: JornadaRama | string | null | undefined = "varonil",
) => {
  const rama = normalizeRama(ramaInput);
  const sucursal = await getSucursalOrThrow(sucursalId);
  const fecha = normalizeFecha(fechaJornada);
  const id = buildInventarioId(fecha, jornadaNumero, sucursalId, rama);
  const ref = col().doc(id);

  const existing = await ref.get();
  if (existing.exists && existing.data()?.activo !== false) {
    const doc = await ref.get();
    return toData(doc);
  }

  await ref.set({
    jornada_fecha: fecha,
    jornada_numero: Number(jornadaNumero),
    sucursal_id: sucursalId,
    concesion_id: sucursal.concesionId,
    rama,
    activo: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const doc = await ref.get();
  return toData(doc);
};

const CIERRE_JORNADA_MOTIVO = "Cierre por cambio de jornada";

const matchesJornadaActiva = (
  data: FirebaseFirestore.DocumentData,
  fechaActiva: string,
  jornadaNumeroActiva: number,
  ramaActiva: JornadaRama,
  inventarioId?: string,
): boolean =>
  String(data.jornada_fecha ?? "") === fechaActiva &&
  Number(data.jornada_numero ?? 0) === jornadaNumeroActiva &&
  ramaFromInventario(data, inventarioId) === ramaActiva;

/**
 * Cierra un inventario obsoleto: pone cantidad_final = 0 en productos
 * con stock y marca el header como activo: false.
 */
export const cerrarInventarioPorCambioJornada = async (
  inventarioId: string,
  sucursalId?: string | null,
) => {
  const ref = col().doc(inventarioId);
  const invDoc = await ref.get();
  if (!invDoc.exists || invDoc.data()?.activo === false) {
    return;
  }

  const invData = invDoc.data() ?? {};
  const resolvedSucursalId =
    sucursalId ?? (invData.sucursal_id as string | undefined) ?? null;

  const prodSnap = await productosCol(inventarioId).get();
  for (const prodDoc of prodSnap.docs) {
    const prev = prodDoc.data() ?? {};
    const prevInicial = Number(prev.cantidad_inicial ?? 0);
    const prevFinal = Number(prev.cantidad_final ?? prevInicial);
    if (prevFinal === 0) {
      continue;
    }

    await prodDoc.ref.set(
      {
        cantidad_final: 0,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await logMovimiento(inventarioId, {
      tipo: "AJUSTE",
      producto_id: String(prev.producto_id ?? prodDoc.id),
      cantidad: -prevFinal,
      cantidad_anterior: prevFinal,
      cantidad_nueva: 0,
      sucursal_id: resolvedSucursalId,
      motivo: CIERRE_JORNADA_MOTIVO,
    });
  }

  await ref.update({
    activo: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
};

/**
 * Cierra inventarios activos de la misma rama que no coinciden con la jornada activa.
 * No toca inventarios de la otra rama.
 */
export const cerrarInventariosObsoletos = async (
  fechaActiva: string,
  jornadaNumeroActiva: string | number,
  ramaInput: JornadaRama | string | null | undefined = "varonil",
) => {
  const fecha = normalizeFecha(fechaActiva);
  const jornadaNumero = Number(jornadaNumeroActiva);
  const rama = normalizeRama(ramaInput);
  const snap = await col().where("activo", "==", true).get();

  const obsoletos = snap.docs.filter((doc) => {
    const data = doc.data();
    if (ramaFromInventario(data, doc.id) !== rama) return false;
    return !matchesJornadaActiva(data, fecha, jornadaNumero, rama, doc.id);
  });

  for (const doc of obsoletos) {
    await cerrarInventarioPorCambioJornada(
      doc.id,
      (doc.data()?.sucursal_id as string | undefined) ?? null,
    );
  }

  return { cerrados: obsoletos.length };
};

export const getOrCreateInventarioJornadaActiva = async (
  sucursalId: string,
  includeProductos = true,
  ramaInput: JornadaRama | string | null | undefined = "varonil",
) => {
  const rama = normalizeRama(ramaInput);
  const { jornadaNumero, fecha, detalle } = await resolveJornadaActiva(rama);
  await cerrarInventariosObsoletos(fecha, jornadaNumero, rama);
  const inventario = await createInventarioPorSucursal(
    jornadaNumero,
    fecha,
    sucursalId,
    rama,
  );
  if (!includeProductos) {
    return { inventario, jornada: detalle };
  }
  const prodSnap = await productosCol(inventario.id).get();
  return {
    inventario: {
      ...inventario,
      productos: prodSnap.docs.map(toData),
    },
    jornada: detalle,
  };
};

const inventarioDocTimestamp = (
  data: FirebaseFirestore.DocumentData,
): number => {
  const updated = data.updatedAt?.toMillis?.() ?? 0;
  const created = data.createdAt?.toMillis?.() ?? 0;
  return Math.max(updated, created);
};

/** Fallback local cuando no hay credenciales de acreditaciones-b904f (RTDB). */
const getInventarioJornadaActivaFromFirestore = async (
  sucursalId: string,
  includeProductos: boolean,
  rama: JornadaRama,
): Promise<{
  inventario: Record<string, unknown> | null;
  jornada: JornadaActivaValue | null;
}> => {
  const snap = await col()
    .where("sucursal_id", "==", sucursalId)
    .where("activo", "==", true)
    .get();

  const ofRama = snap.docs.filter(
    (doc) => ramaFromInventario(doc.data(), doc.id) === rama,
  );

  if (ofRama.length === 0) {
    return { inventario: null, jornada: null };
  }

  const sorted = ofRama.sort(
    (a, b) =>
      inventarioDocTimestamp(b.data()) - inventarioDocTimestamp(a.data()),
  );
  const doc = sorted[0];
  const obsoletos = sorted.slice(1);

  for (const obsolete of obsoletos) {
    await cerrarInventarioPorCambioJornada(obsolete.id, sucursalId);
  }

  const data = doc.data();
  const jornada: JornadaActivaValue = {
    activo: true,
    jornada: data.jornada_numero,
    fecha: data.jornada_fecha,
    rama,
  };

  const inventario = toData(doc);
  if (!includeProductos) {
    return { inventario, jornada };
  }

  const prodSnap = await productosCol(doc.id).get();
  return {
    inventario: {
      ...inventario,
      productos: prodSnap.docs.map(toData),
    },
    jornada,
  };
};

export const getInventarioJornadaActiva = async (
  sucursalId: string,
  includeProductos = true,
  ramaInput: JornadaRama | string | null | undefined = "varonil",
) => {
  const rama = normalizeRama(ramaInput);

  if (!isAppOficial2Configured()) {
    return getInventarioJornadaActivaFromFirestore(
      sucursalId,
      includeProductos,
      rama,
    );
  }

  const { jornadaNumero, fecha, detalle } = await resolveJornadaActiva(rama);
  await cerrarInventariosObsoletos(fecha, jornadaNumero, rama);
  const id = buildInventarioId(fecha, jornadaNumero, sucursalId, rama);
  const doc = await col().doc(id).get();

  if (!doc.exists || doc.data()?.activo === false) {
    return { inventario: null, jornada: detalle };
  }

  const inventario = toData(doc);
  if (!includeProductos) {
    return { inventario, jornada: detalle };
  }

  const prodSnap = await productosCol(id).get();
  return {
    inventario: {
      ...inventario,
      productos: prodSnap.docs.map(toData),
    },
    jornada: detalle,
  };
};

export const listInventarios = async (
  includeProductos: boolean,
  filters?: { concesionId?: string; sucursalId?: string },
) => {
  let query: FirebaseFirestore.Query = col().where("activo", "==", true);
  if (filters?.concesionId) {
    query = query.where("concesion_id", "==", filters.concesionId);
  } else if (filters?.sucursalId) {
    query = query.where("sucursal_id", "==", filters.sucursalId);
  }
  const snap = await query.get();
  let inventarios = snap.docs.map(toData);
  if (filters?.sucursalId) {
    inventarios = inventarios.filter(
      (inv) => (inv as { sucursal_id?: string }).sucursal_id === filters.sucursalId,
    );
  }

  if (!includeProductos) return inventarios;

  return Promise.all(
    inventarios.map(async (inv) => {
      const prodSnap = await productosCol(inv.id).get();
      return { ...inv, productos: prodSnap.docs.map(toData) };
    }),
  );
};

export const getInventarioById = async (
  id: string,
  includeProductos: boolean,
) => {
  const doc = await col().doc(id).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const inv = toData(doc);
  if (!includeProductos) {
    return inv;
  }
  const prodSnap = await productosCol(id).get();
  return { ...inv, productos: prodSnap.docs.map(toData) };
};

export const createInventario = createInventarioPorSucursal;

export const softDeleteInventario = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
};

export const listInventarioProductos = async (inventarioId: string) => {
  const doc = await col().doc(inventarioId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const snap = await productosCol(inventarioId).get();
  return snap.docs.map(toData);
};

export const getInventarioProducto = async (
  inventarioId: string,
  productoId: string,
) => {
  const doc = await productosCol(inventarioId).doc(productoId).get();
  if (!doc.exists) {
    throw new ApiError(
      404,
      "Producto de inventario no encontrado",
      true,
      "NOT_FOUND",
    );
  }
  return toData(doc);
};

export const upsertInventarioProducto = async (
  inventarioId: string,
  productoId: string,
  data: Partial<{
    producto_id: string;
    cantidad_inicial: number;
    cantidad_final: number;
    precio_jornada: number;
  }>,
  context?: { idUser?: string },
) => {
  const invDoc = await col().doc(inventarioId).get();
  if (!invDoc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }

  const invConcesionId = invDoc.data()?.concesion_id as string;
  const catalogDoc = await firestorePos.collection(COLLECTIONS.PRODUCTS).doc(productoId).get();
  if (!catalogDoc.exists || catalogDoc.data()?.concesion_id !== invConcesionId) {
    throw new ApiError(
      400,
      "El producto no pertenece a la concesión del inventario",
      true,
      "INVALID_PRODUCT",
    );
  }

  const ref = productosCol(inventarioId).doc(productoId);
  const existing = await ref.get();
  const prev = existing.data() ?? {};
  const prevInicial = Number(prev.cantidad_inicial ?? 0);
  const prevFinal = Number(prev.cantidad_final ?? prevInicial);

  let cantidadInicial = prevInicial;
  let cantidadFinal = prevFinal;

  if (data.cantidad_inicial !== undefined) {
    cantidadInicial = Number(data.cantidad_inicial);
    if (!existing.exists) {
      cantidadFinal = cantidadInicial;
    } else if (data.cantidad_final === undefined) {
      const vendido = prevInicial - prevFinal;
      cantidadFinal = Math.max(0, cantidadInicial - vendido);
    }
  }

  if (data.cantidad_final !== undefined) {
    cantidadFinal = Number(data.cantidad_final);
  }

  const payload = {
    producto_id: data.producto_id ?? productoId,
    cantidad_inicial: cantidadInicial,
    cantidad_final: cantidadFinal,
    ...(data.precio_jornada !== undefined
      ? { precio_jornada: data.precio_jornada }
      : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await ref.set(payload, { merge: true });

  const deltaFinal = cantidadFinal - prevFinal;
  if (deltaFinal !== 0) {
    const tipo: InventarioMovimientoTipo = existing.exists
      ? "AJUSTE"
      : "CARGA_INICIAL";
    await logMovimiento(inventarioId, {
      tipo,
      producto_id: productoId,
      cantidad: deltaFinal,
      cantidad_anterior: prevFinal,
      cantidad_nueva: cantidadFinal,
      idUser: context?.idUser ?? null,
    });
  }

  const doc = await ref.get();
  return toData(doc);
};

export type AjusteDireccion = "entrada" | "salida";

export const ajustarInventarioProducto = async (
  inventarioId: string,
  productoId: string,
  data: {
    direccion: AjusteDireccion;
    cantidad: number;
    motivo?: string;
  },
  context?: { idUser?: string },
) => {
  const invDoc = await col().doc(inventarioId).get();
  if (!invDoc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }

  const ref = productosCol(inventarioId).doc(productoId);
  const existing = await ref.get();
  if (!existing.exists) {
    throw new ApiError(
      404,
      "Producto de inventario no encontrado. Usa Cargar producto para el inventario inicial.",
      true,
      "NOT_FOUND",
    );
  }

  const prev = existing.data() ?? {};
  const prevInicial = Number(prev.cantidad_inicial ?? 0);
  const prevFinal = Number(prev.cantidad_final ?? prevInicial);
  const cantidad = Number(data.cantidad);

  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new ApiError(
      400,
      "La cantidad del ajuste debe ser mayor a 0",
      true,
      "INVALID_CANTIDAD",
    );
  }

  const delta = data.direccion === "entrada" ? cantidad : -cantidad;
  const cantidadFinal = prevFinal + delta;

  if (cantidadFinal < 0) {
    throw new ApiError(
      400,
      `Stock insuficiente: disponible ${prevFinal}, salida ${cantidad}`,
      true,
      "INSUFFICIENT_STOCK",
    );
  }

  await ref.set(
    {
      cantidad_final: cantidadFinal,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const motivo =
    typeof data.motivo === "string" && data.motivo.trim()
      ? data.motivo.trim()
      : null;

  await logMovimiento(inventarioId, {
    tipo: "AJUSTE",
    producto_id: productoId,
    cantidad: delta,
    cantidad_anterior: prevFinal,
    cantidad_nueva: cantidadFinal,
    idUser: context?.idUser ?? null,
    motivo,
  });

  const doc = await ref.get();
  return toData(doc);
};

export const deleteInventarioProducto = async (
  inventarioId: string,
  productoId: string,
) => {
  const ref = productosCol(inventarioId).doc(productoId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(
      404,
      "Producto de inventario no encontrado",
      true,
      "NOT_FOUND",
    );
  }
  await ref.delete();
};

/** Registra movimiento VENTA dentro de una transacción Firestore. */
export const logMovimientoInTransaction = (
  tx: FirebaseFirestore.Transaction,
  inventarioId: string,
  payload: LogMovimientoInput,
) => {
  const ref = movimientosCol(inventarioId).doc();
  tx.set(ref, {
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
  });
};
