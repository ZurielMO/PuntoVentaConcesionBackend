import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import * as sucursalService from "./sucursal.service";
import { getUserById } from "./user.service";

const col = () => firestorePos.collection(COLLECTIONS.ASIGNACIONES_CAJAS_JORNADA);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export const buildJornadaId = (fecha: string, jornadaNumero: number | string) =>
  `${fecha}__J${jornadaNumero}`;

export const listAsignacionesCajas = async (params: {
  jornadaId: string;
  sucursalId?: string;
  concesionId?: string;
}) => {
  let query: FirebaseFirestore.Query = col()
    .where("jornadaId", "==", params.jornadaId)
    .where("activo", "==", true);

  if (params.sucursalId) {
    query = query.where("sucursalId", "==", params.sucursalId);
  }
  if (params.concesionId) {
    query = query.where("concesionId", "==", params.concesionId);
  }

  const snap = await query.get();
  return snap.docs.map(toData);
};

export const upsertAsignacionesCajas = async (params: {
  jornadaId: string;
  concesionId: string;
  sucursalId: string;
  asignaciones: { cajaId: string; vendedorUid: string | null }[];
}) => {
  const vendedoresUsados = new Set<string>();
  for (const item of params.asignaciones) {
    if (!item.vendedorUid) continue;
    if (vendedoresUsados.has(item.vendedorUid)) {
      throw new ApiError(
        400,
        "Un vendedor no puede estar asignado a más de una caja en la misma jornada",
        true,
        "VENDEDOR_DUPLICADO",
      );
    }
    vendedoresUsados.add(item.vendedorUid);
  }

  const existingSnap = await col()
    .where("jornadaId", "==", params.jornadaId)
    .where("sucursalId", "==", params.sucursalId)
    .where("activo", "==", true)
    .get();

  const batch = firestorePos.batch();
  existingSnap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      activo: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  for (const item of params.asignaciones) {
    if (!item.vendedorUid) continue;

    const caja = await sucursalService.assertCajaBelongsToSucursal(
      params.sucursalId,
      item.cajaId,
    );
    const vendedor = await getUserById(item.vendedorUid);
    if (vendedor.concesionId !== params.concesionId) {
      throw new ApiError(
        400,
        "El vendedor no pertenece a esta concesión",
        true,
        "INVALID_VENDEDOR",
      );
    }
    if (vendedor.sucursalId && vendedor.sucursalId !== params.sucursalId) {
      throw new ApiError(
        400,
        "El vendedor no pertenece a esta sucursal",
        true,
        "INVALID_VENDEDOR_SUCURSAL",
      );
    }

    const ref = col().doc();
    batch.set(ref, {
      jornadaId: params.jornadaId,
      concesionId: params.concesionId,
      sucursalId: params.sucursalId,
      cajaId: item.cajaId,
      cajaNombre: caja.nombre,
      vendedorUid: item.vendedorUid,
      vendedorNombre: (vendedor.nombre as string) ?? "Vendedor",
      activo: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  return listAsignacionesCajas({
    jornadaId: params.jornadaId,
    sucursalId: params.sucursalId,
    concesionId: params.concesionId,
  });
};

export const resolveCajaActivaParaVendedor = async (params: {
  vendedorUid: string;
  jornadaId: string;
  sucursalId: string;
  fallbackCajaId?: string | null;
}): Promise<{ cajaId: string; cajaNombre: string } | null> => {
  const snap = await col()
    .where("jornadaId", "==", params.jornadaId)
    .where("sucursalId", "==", params.sucursalId)
    .where("vendedorUid", "==", params.vendedorUid)
    .where("activo", "==", true)
    .limit(1)
    .get();

  if (!snap.empty) {
    const data = snap.docs[0].data();
    return {
      cajaId: data.cajaId as string,
      cajaNombre: data.cajaNombre as string,
    };
  }

  if (params.fallbackCajaId) {
    const caja = await sucursalService.getCajaById(
      params.sucursalId,
      params.fallbackCajaId,
    );
    if (caja.activo !== false) {
      return {
        cajaId: caja.id,
        cajaNombre: caja.nombre as string,
      };
    }
  }

  return null;
};

export const getCajaIdsForVendedorEnJornada = async (params: {
  vendedorUid: string;
  jornadaId: string;
  sucursalId: string;
  fallbackCajaId?: string | null;
}): Promise<string[]> => {
  const resolved = await resolveCajaActivaParaVendedor(params);
  return resolved ? [resolved.cajaId] : [];
};
