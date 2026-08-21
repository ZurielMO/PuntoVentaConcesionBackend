import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { DescuentoTipo } from "../models";

const col = () => firestorePos.collection(COLLECTIONS.DESCUENTOS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

const assertConcessionExists = async (concesionId: string) => {
  const doc = await firestorePos
    .collection(COLLECTIONS.CONCESIONES)
    .doc(concesionId)
    .get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }
};

const assertProductosDeConcesion = async (
  concesionId: string,
  productoIds: string[],
) => {
  const unique = [...new Set(productoIds)];
  const docs = await Promise.all(
    unique.map((id) => firestorePos.collection(COLLECTIONS.PRODUCTS).doc(id).get()),
  );
  for (const doc of docs) {
    if (!doc.exists || doc.data()?.activo === false) {
      throw new ApiError(
        400,
        `El producto ${doc.id} no existe o está inactivo`,
        true,
        "INVALID_PRODUCT",
      );
    }
    if (doc.data()?.concesion_id !== concesionId) {
      throw new ApiError(
        400,
        `El producto ${doc.id} no pertenece a la concesión`,
        true,
        "INVALID_PRODUCT",
      );
    }
  }
};

/** Valida coherencia tipo/valor: 2X1 y 3X2 no llevan valor; % y monto sí. */
const assertTipoValor = (tipo: DescuentoTipo, valor?: number | null) => {
  if (tipo === "PORCENTAJE") {
    if (valor == null || valor <= 0 || valor > 100) {
      throw new ApiError(
        400,
        "El descuento por porcentaje requiere un valor entre 1 y 100",
        true,
        "INVALID_VALUE",
      );
    }
  } else if (tipo === "MONTO") {
    if (valor == null || valor <= 0) {
      throw new ApiError(
        400,
        "El descuento por monto requiere un valor mayor a 0",
        true,
        "INVALID_VALUE",
      );
    }
  }
};

export interface DescuentoInput {
  titulo: string;
  descripcion?: string | null;
  tipo: DescuentoTipo;
  valor?: number | null;
  producto_ids: string[];
  activo?: boolean;
}

export const listDescuentos = async (filters?: {
  concesionId?: string;
  includeInactive?: boolean;
}) => {
  let query: FirebaseFirestore.Query = col();
  if (filters?.concesionId) {
    query = query.where("concesion_id", "==", filters.concesionId);
  } else if (!filters?.includeInactive) {
    query = query.where("activo", "==", true);
  }
  const snap = await query.get();
  const rows = snap.docs.map(toData);
  if (filters?.includeInactive) return rows;
  return rows.filter((row) => (row as { activo?: boolean }).activo !== false);
};

export const getDescuentoById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Descuento no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createDescuento = async (
  concesionId: string,
  data: DescuentoInput,
  createdBy?: { uid?: string | null; nombre?: string | null },
) => {
  await assertConcessionExists(concesionId);
  assertTipoValor(data.tipo, data.valor);
  await assertProductosDeConcesion(concesionId, data.producto_ids);

  const payload = {
    concesion_id: concesionId,
    titulo: data.titulo,
    descripcion: data.descripcion ?? null,
    tipo: data.tipo,
    valor: data.tipo === "PORCENTAJE" || data.tipo === "MONTO" ? data.valor : null,
    producto_ids: data.producto_ids,
    activo: data.activo ?? true,
    createdByUid: createdBy?.uid ?? null,
    createdByNombre: createdBy?.nombre ?? null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const updateDescuento = async (
  id: string,
  data: Partial<DescuentoInput>,
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Descuento no encontrado", true, "NOT_FOUND");
  }

  const tipo = (data.tipo ?? doc.data()?.tipo) as DescuentoTipo;
  const valor = data.valor !== undefined ? data.valor : (doc.data()?.valor as number | null);
  assertTipoValor(tipo, valor);

  if (data.producto_ids) {
    const concesionId = doc.data()?.concesion_id as string;
    await assertProductosDeConcesion(concesionId, data.producto_ids);
  }

  await ref.update({
    ...data,
    valor: tipo === "PORCENTAJE" || tipo === "MONTO" ? valor : null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const updated = await ref.get();
  return toData(updated);
};

export const softDeleteDescuento = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Descuento no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
};

/** Eliminación física del documento en Firestore. */
export const hardDeleteDescuento = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Descuento no encontrado", true, "NOT_FOUND");
  }
  await ref.delete();
};
