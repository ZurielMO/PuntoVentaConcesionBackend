import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.TICKETS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export interface TicketListFilters {
  concesionId?: string;
  sucursalId?: string;
  idUser?: string;
}

export const listTickets = async (filters: TicketListFilters = {}) => {
  let query: FirebaseFirestore.Query = col();
  if (filters.concesionId) {
    query = query.where("concesionId", "==", filters.concesionId);
  }
  if (filters.sucursalId) {
    query = query.where("sucursalId", "==", filters.sucursalId);
  }
  if (filters.idUser) {
    query = query.where("idUser", "==", filters.idUser);
  }
  const snap = await query.get();
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
  context: { concesionId: string; sucursalId?: string | null; idUser: string },
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
    concesionId: context.concesionId,
    sucursalId: context.sucursalId ?? null,
    idUser: context.idUser,
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
