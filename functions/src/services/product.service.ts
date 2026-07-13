import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { normalizeRecordImageUrls } from "./storage.service";

const col = () => firestorePos.collection(COLLECTIONS.PRODUCTS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> & { id: string } =>
  normalizeRecordImageUrls({
    id: doc.id,
    ...doc.data(),
  });

export const listProductsByConcession = async (
  concesionId: string,
  includeInactive = false,
) => {
  let query: FirebaseFirestore.Query = col().where(
    "concesion_id",
    "==",
    concesionId,
  );
  if (!includeInactive) {
    query = query.where("activo", "==", true);
  }
  const snap = await query.get();
  return snap.docs.map(toData);
};

export const listProducts = async (
  concesionId?: string,
  includeInactive = false,
) => {
  let query: FirebaseFirestore.Query = col();
  if (!includeInactive) {
    query = query.where("activo", "==", true);
  }
  if (concesionId) {
    query = query.where("concesion_id", "==", concesionId);
  }
  const snap = await query.get();
  return snap.docs.map(toData);
};

export const getProductById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Producto no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

const assertUniqueName = async (
  concesionId: string,
  nombre: string,
  excludeId?: string,
) => {
  const snap = await col()
    .where("concesion_id", "==", concesionId)
    .where("nombre", "==", nombre)
    .get();
  const conflict = snap.docs.find(
    (d) => d.id !== excludeId && d.data().activo !== false,
  );
  if (conflict) {
    throw new ApiError(
      409,
      "Ya existe un producto con ese nombre en la concesión",
      true,
      "DUPLICATE_PRODUCT",
    );
  }
};

export const createProduct = async (
  concesionId: string,
  data: {
    nombre: string;
    unidad_medida: string;
    precio: number;
    imagenes?: string[];
    activo?: boolean;
  },
) => {
  await assertUniqueName(concesionId, data.nombre);
  const payload = {
    concesion_id: concesionId,
    nombre: data.nombre,
    unidad_medida: data.unidad_medida,
    precio: data.precio,
    imagenes: data.imagenes ?? [],
    activo: data.activo ?? true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const updateProduct = async (
  id: string,
  data: Partial<{
    nombre: string;
    unidad_medida: string;
    precio: number;
    imagenes: string[];
    activo: boolean;
  }>,
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Producto no encontrado", true, "NOT_FOUND");
  }

  // No se permite cambiar concesion_id.
  if (data.nombre) {
    const concesionId = doc.data()?.concesion_id;
    await assertUniqueName(concesionId, data.nombre, id);
  }

  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return toData(updated);
};

export const softDeleteProduct = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Producto no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
};

export const appendProductImages = async (
  id: string,
  newUrls: string[],
) => {
  const product = await getProductById(id);
  const imagenes = [...((product.imagenes as string[] | undefined) ?? []), ...newUrls];
  return updateProduct(id, { imagenes });
};

export const removeProductImageAtIndex = async (id: string, index: number) => {
  const product = await getProductById(id);
  const imagenes = [...((product.imagenes as string[] | undefined) ?? [])];
  if (index < 0 || index >= imagenes.length) {
    throw new ApiError(404, "Imagen no encontrada", true, "NOT_FOUND");
  }
  const removedUrl = imagenes[index];
  imagenes.splice(index, 1);
  const updated = await updateProduct(id, { imagenes });
  return { updated, removedUrl };
};
