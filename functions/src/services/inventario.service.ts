import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { InventarioMovimientoTipo } from "../models";
import { resolveJornadaPrimaria } from "./jornada.service";

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

/** ID compuesto por concesión: `2026-03-14__J11__concesionId`. */
export const buildInventarioId = (
  fecha: string,
  jornadaNumero: string | number,
  concesionId: string,
): string => `${normalizeFecha(fecha)}__J${jornadaNumero}__${concesionId}`;

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
  idUser?: string | null;
  ventaId?: string | null;
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

const assertConcessionExists = async (concesionId: string) => {
  const doc = await firestorePos.collection(COLLECTIONS.CONCESIONES).doc(concesionId).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }
};

export const createInventarioPorConcesion = async (
  jornadaNumero: string | number,
  fechaJornada: string,
  concesionId: string,
) => {
  await assertConcessionExists(concesionId);
  const fecha = normalizeFecha(fechaJornada);
  const id = buildInventarioId(fecha, jornadaNumero, concesionId);
  const ref = col().doc(id);

  const existing = await ref.get();
  if (existing.exists && existing.data()?.activo !== false) {
    const doc = await ref.get();
    return toData(doc);
  }

  await ref.set({
    jornada_fecha: fecha,
    jornada_numero: Number(jornadaNumero),
    concesion_id: concesionId,
    activo: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const doc = await ref.get();
  return toData(doc);
};

export const getOrCreateInventarioJornadaActiva = async (
  concesionId: string,
  includeProductos = true,
) => {
  const { jornadaNumero, fecha, detalle } = await resolveJornadaPrimaria();
  const inventario = await createInventarioPorConcesion(
    jornadaNumero,
    fecha,
    concesionId,
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

export const getInventarioJornadaActiva = async (
  concesionId: string,
  includeProductos = true,
) => {
  const { jornadaNumero, fecha, detalle } = await resolveJornadaPrimaria();
  const id = buildInventarioId(fecha, jornadaNumero, concesionId);
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

export const listInventarios = async (includeProductos: boolean, concesionId?: string) => {
  let query: FirebaseFirestore.Query = col().where("activo", "==", true);
  if (concesionId) {
    query = query.where("concesion_id", "==", concesionId);
  }
  const snap = await query.get();
  const inventarios = snap.docs.map(toData);

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

/** @deprecated Legacy: inventario por sucursal. Usar createInventarioPorConcesion. */
export const createInventario = async (
  jornadaNumero: string,
  fechaJornada: string,
  sucursalId: string,
) => {
  const sucursalDoc = await firestorePos.collection(COLLECTIONS.SUCURSALES).doc(sucursalId).get();
  if (!sucursalDoc.exists) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  const concesionId = sucursalDoc.data()?.concesion_id;
  if (!concesionId) {
    throw new ApiError(400, "Sucursal sin concesión asignada", true, "BAD_REQUEST");
  }
  return createInventarioPorConcesion(jornadaNumero, fechaJornada, concesionId);
};

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
