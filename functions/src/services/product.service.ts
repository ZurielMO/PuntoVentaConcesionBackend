import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.PRODUCTS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export const listProductsByConcession = async (concesionId: string) => {
  const snap = await col()
    .where("concesion_id", "==", concesionId)
    .where("activo", "==", true)
    .get();
  return snap.docs.map(toData);
};

export const listProducts = async () => {
  const snap = await col().where("activo", "==", true).get();
  return snap.docs.map(toData);
};

export const getProductById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists || doc.data()?.activo === false) {
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
