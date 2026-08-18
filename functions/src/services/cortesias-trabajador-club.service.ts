import { FieldValue } from "firebase-admin/firestore";
import { firestoreApp, USUARIOS_APP_COLLECTION } from "../config/app.firebase";
import { getRealtimeDbAppOficial2 } from "../config/firebase.appoficial2";

export const CORTESIAS_SUBCOLLECTION = "cortesias";

export type PartidoLeonLocal = {
  partidoKey: string;
  jornada: number;
  fecha: string;
  hora?: string | null;
  equipoLocal: string;
  equipoVisitante: string;
  estadio?: string | null;
};

export type CortesiaTrabajadorClubDoc = {
  id: string;
  torneo: string;
  torneoPath: string;
  partidoKey: string;
  jornada: number;
  fecha: string;
  hora?: string | null;
  equipoLocal: string;
  equipoVisitante: string;
  estadio?: string | null;
  cortesiaCanjeada: boolean;
  syncedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

type RtdbPartido = {
  jornada?: number;
  fecha?: string;
  hora?: string;
  equipo_local?: string;
  equipo_visitante?: string;
  estadio?: string;
};

const getTorneoPartidosPath = (): string =>
  process.env.CORTESIAS_TORNEO_RTDB_PATH?.trim() ||
  "torneo/liga mx/2026/apertura/partidos";

const getTorneoLabel = (): string =>
  process.env.CORTESIAS_TORNEO_LABEL?.trim() || "Apertura 2026";

const getTorneoBasePath = (): string =>
  getTorneoPartidosPath().replace(/\/partidos$/i, "");

const normalizeTeamName = (name?: string): string =>
  (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const isLeonLocalTeam = (equipoLocal?: string): boolean =>
  normalizeTeamName(equipoLocal).includes("leon");

export const normalizeFechaPartido = (fecha: string): string => {
  const raw = fecha.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return raw;
};

export const buildCortesiaDocId = (torneoLabel: string, jornada: number): string => {
  const slug = torneoLabel
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${slug}__J${jornada}`;
};

export const fetchPartidosLeonLocal = async (): Promise<PartidoLeonLocal[]> => {
  const db = getRealtimeDbAppOficial2();
  const snapshot = await db.ref(getTorneoPartidosPath()).get();
  if (!snapshot.exists()) return [];

  const value = snapshot.val() as Record<string, RtdbPartido>;
  const partidos: PartidoLeonLocal[] = [];

  for (const [partidoKey, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    if (!isLeonLocalTeam(raw.equipo_local)) continue;
    if (raw.jornada == null || !raw.fecha) continue;

    partidos.push({
      partidoKey,
      jornada: Number(raw.jornada),
      fecha: normalizeFechaPartido(String(raw.fecha)),
      hora: raw.hora ? String(raw.hora) : null,
      equipoLocal: String(raw.equipo_local ?? ""),
      equipoVisitante: String(raw.equipo_visitante ?? ""),
      estadio: raw.estadio ? String(raw.estadio) : null,
    });
  }

  return partidos.sort((a, b) => a.jornada - b.jornada);
};

const tsToIso = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  if ("toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if ("_seconds" in value) {
    return new Date((value as { _seconds: number })._seconds * 1000).toISOString();
  }
  return null;
};

export const mapCortesiaDoc = (
  id: string,
  data: FirebaseFirestore.DocumentData,
): CortesiaTrabajadorClubDoc => ({
  id,
  torneo: String(data.torneo ?? ""),
  torneoPath: String(data.torneoPath ?? ""),
  partidoKey: String(data.partidoKey ?? ""),
  jornada: Number(data.jornada ?? 0),
  fecha: String(data.fecha ?? ""),
  hora: (data.hora as string | null | undefined) ?? null,
  equipoLocal: String(data.equipoLocal ?? ""),
  equipoVisitante: String(data.equipoVisitante ?? ""),
  estadio: (data.estadio as string | null | undefined) ?? null,
  cortesiaCanjeada: data.cortesiaCanjeada === true,
  syncedAt: tsToIso(data.syncedAt),
  updatedAt: tsToIso(data.updatedAt),
  createdAt: tsToIso(data.createdAt),
});

const migrateLegacyTargetJornada = (
  usuarioData: FirebaseFirestore.DocumentData,
  partidos: PartidoLeonLocal[],
): number | null => {
  if (usuarioData.cortesiaCanjeada !== true || partidos.length === 0) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  const upcoming = partidos.filter((p) => p.fecha >= hoy);
  return upcoming[0]?.jornada ?? partidos[partidos.length - 1]?.jornada ?? null;
};

export const syncCortesiasForUsuario = async (
  usuarioRef: FirebaseFirestore.DocumentReference,
  partidos?: PartidoLeonLocal[],
): Promise<{ creadas: number; actualizadas: number }> => {
  const matches = partidos ?? (await fetchPartidosLeonLocal());
  const torneoLabel = getTorneoLabel();
  const torneoPath = getTorneoBasePath();
  const now = FieldValue.serverTimestamp();

  const usuarioSnap = await usuarioRef.get();
  if (!usuarioSnap.exists) return { creadas: 0, actualizadas: 0 };

  const usuarioData = usuarioSnap.data() ?? {};
  const legacyTargetJornada = migrateLegacyTargetJornada(usuarioData, matches);

  let creadas = 0;
  let actualizadas = 0;
  let batch = firestoreApp.batch();
  let ops = 0;

  const commitIfNeeded = async (force = false) => {
    if (ops > 0 && (force || ops >= 450)) {
      await batch.commit();
      batch = firestoreApp.batch();
      ops = 0;
    }
  };

  for (const partido of matches) {
    const cortesiaId = buildCortesiaDocId(torneoLabel, partido.jornada);
    const cortesiaRef = usuarioRef.collection(CORTESIAS_SUBCOLLECTION).doc(cortesiaId);
    const existing = await cortesiaRef.get();

    const metadata = {
      torneo: torneoLabel,
      torneoPath,
      partidoKey: partido.partidoKey,
      jornada: partido.jornada,
      fecha: partido.fecha,
      hora: partido.hora ?? null,
      equipoLocal: partido.equipoLocal,
      equipoVisitante: partido.equipoVisitante,
      estadio: partido.estadio ?? null,
      syncedAt: now,
      updatedAt: now,
    };

    if (!existing.exists) {
      batch.set(cortesiaRef, {
        ...metadata,
        cortesiaCanjeada: legacyTargetJornada === partido.jornada,
        createdAt: now,
      });
      creadas += 1;
    } else {
      const prev = existing.data() ?? {};
      batch.update(cortesiaRef, {
        ...metadata,
        cortesiaCanjeada: prev.cortesiaCanjeada === true,
      });
      actualizadas += 1;
    }

    ops += 1;
    await commitIfNeeded();
  }

  await commitIfNeeded(true);

  const rootUpdate: Record<string, unknown> = { updatedAt: now };
  if ("cortesiaCanjeada" in usuarioData) {
    rootUpdate.cortesiaCanjeada = FieldValue.delete();
  }
  await usuarioRef.update(rootUpdate);

  return { creadas, actualizadas };
};

export const deleteCortesiasForUsuario = async (
  usuarioRef: FirebaseFirestore.DocumentReference,
): Promise<void> => {
  const snap = await usuarioRef.collection(CORTESIAS_SUBCOLLECTION).get();
  if (snap.empty) {
    await usuarioRef.update({
      cortesiaCanjeada: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const batch = firestoreApp.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  batch.update(usuarioRef, {
    cortesiaCanjeada: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
};

export const getCortesiasResumen = async (
  usuarioRef: FirebaseFirestore.DocumentReference,
): Promise<{ cortesiasTotal: number; cortesiasCanjeadas: number }> => {
  const snap = await usuarioRef.collection(CORTESIAS_SUBCOLLECTION).get();
  const cortesiasCanjeadas = snap.docs.filter(
    (doc) => doc.data()?.cortesiaCanjeada === true,
  ).length;
  return { cortesiasTotal: snap.size, cortesiasCanjeadas };
};

export const listCortesiasByUsuarioRef = async (
  usuarioRef: FirebaseFirestore.DocumentReference,
): Promise<CortesiaTrabajadorClubDoc[]> => {
  const snap = await usuarioRef
    .collection(CORTESIAS_SUBCOLLECTION)
    .orderBy("jornada", "asc")
    .get();
  return snap.docs.map((doc) => mapCortesiaDoc(doc.id, doc.data()));
};

export const updateCortesiaCanjeadaDoc = async (
  usuarioRef: FirebaseFirestore.DocumentReference,
  cortesiaId: string,
  cortesiaCanjeada: boolean,
): Promise<CortesiaTrabajadorClubDoc> => {
  const cortesiaRef = usuarioRef.collection(CORTESIAS_SUBCOLLECTION).doc(cortesiaId);
  const existing = await cortesiaRef.get();
  if (!existing.exists) {
    throw new Error("Cortesía no encontrada");
  }

  await cortesiaRef.update({
    cortesiaCanjeada,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await cortesiaRef.get();
  return mapCortesiaDoc(updated.id, updated.data() ?? {});
};

export const findUsuarioRefByUid = async (
  uid: string,
): Promise<FirebaseFirestore.DocumentReference | null> => {
  const snap = await firestoreApp
    .collection(USUARIOS_APP_COLLECTION)
    .where("uid", "==", uid)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].ref;
};
