import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.TICKETS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export const listTickets = async () => {
  const snap = await col().get();
  return snap.docs.map(toData);
};

export const getTicketById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Ticket no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createTicket = async (
  idUser: string | undefined,
  data: {
    fecha: string;
    metodo_pago: string;
    subtotal: number;
    total: number;
    status?: string;
  },
) => {
  const payload = {
    fecha: data.fecha,
    metodo_pago: data.metodo_pago,
    subtotal: data.subtotal,
    total: data.total,
    status: data.status ?? "PENDIENTE",
    idUser: idUser ?? null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await col().add(payload);
  const doc = await ref.get();
  return toData(doc);
};

export const updateTicket = async (
  id: string,
  data: Partial<{
    metodo_pago: string;
    subtotal: number;
    total: number;
    status: string;
  }>,
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Ticket no encontrado", true, "NOT_FOUND");
  }
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return toData(updated);
};
