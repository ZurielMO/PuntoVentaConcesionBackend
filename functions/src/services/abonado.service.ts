import { admin } from "../config/firebase.admin";
import {
  firestoreApp,
  hasAppOficialCredentials,
  USUARIOS_APP_COLLECTION,
} from "../config/app.firebase";
import {
  ABONADO_BENEFITS_CATALOG,
  ABONADO_BENEFIT_ONCE_PER_VENTA,
  AbonadoBenefitDefinition,
  getBenefitDefinition,
} from "../config/abonado-benefits.config";
import { ApiError } from "../utils/api-error";

type SeasonPassVerification = {
  isSubscriber?: boolean;
  event?: string;
  season?: string;
  phone?: string;
  posBeneficiosConsumidos?: Record<
    string,
    { ventaId?: string; consumedAt?: admin.firestore.Timestamp }
  >;
};

export interface AbonadoBenefitStatus {
  id: string;
  titulo: string;
  descripcion: string;
  tipo: AbonadoBenefitDefinition["tipo"];
  productNameTokens: string[];
  productIds: string[];
  disponible: boolean;
  consumidoAt?: string;
  consumidoVentaId?: string;
}

export interface AbonadoVerificationResult {
  memberId: string;
  nombre: string;
  email: string;
  isSubscriber: boolean;
  event?: string;
  season?: string;
  benefits: AbonadoBenefitStatus[];
}

export interface ConsumeAbonadoBenefitResult {
  memberId: string;
  benefitId: string;
  ventaId: string;
  consumedAt: string;
}

const usuariosCol = () => firestoreApp.collection(USUARIOS_APP_COLLECTION);

const getUserDocumentByUid = async (uid: string) => {
  const directRef = usuariosCol().doc(uid);
  const directSnap = await directRef.get();
  if (directSnap.exists) {
    return { ref: directRef, snap: directSnap };
  }

  const snapshot = await usuariosCol().where("uid", "==", uid).limit(1).get();
  if (snapshot.empty) {
    return null;
  }

  const snap = snapshot.docs[0];
  return { ref: snap.ref, snap };
};

const serializeTimestamp = (value: unknown): string | undefined => {
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return undefined;
};

const buildBenefitStatuses = (
  verification: SeasonPassVerification | undefined,
): AbonadoBenefitStatus[] => {
  const consumed = verification?.posBeneficiosConsumidos ?? {};

  return ABONADO_BENEFITS_CATALOG.map((definition) => {
    const usage = consumed[definition.id];
    const consumidoAt = serializeTimestamp(usage?.consumedAt);

    return {
      id: definition.id,
      titulo: definition.titulo,
      descripcion: definition.descripcion,
      tipo: definition.tipo,
      productNameTokens: definition.productNameTokens,
      productIds: definition.productIds ?? [],
      // TEMP: revert to once per jornada after testing
      disponible: ABONADO_BENEFIT_ONCE_PER_VENTA || !consumidoAt,
      consumidoAt,
      consumidoVentaId: usage?.ventaId,
    };
  });
};

const assertAppOficialReady = (): void => {
  if (!hasAppOficialCredentials) {
    throw new ApiError(
      503,
      "Integración de abonados no configurada (SERVICE_ACCOUNT_APP_OFICIAL)",
      true,
      "ABONADO_NOT_CONFIGURED",
    );
  }
};

export const verifyAbonado = async (
  memberId: string,
): Promise<AbonadoVerificationResult> => {
  assertAppOficialReady();

  const trimmedId = memberId.trim();
  if (!trimmedId) {
    throw new ApiError(400, "ID de abonado inválido", true, "INVALID_MEMBER_ID");
  }

  const userDocument = await getUserDocumentByUid(trimmedId);
  if (!userDocument) {
    throw new ApiError(404, "Usuario no encontrado", true, "MEMBER_NOT_FOUND");
  }

  const data = userDocument.snap.data() ?? {};
  const verification = data.seasonPassVerification as
    | SeasonPassVerification
    | undefined;
  const isSubscriber = verification?.isSubscriber === true;

  if (!isSubscriber) {
    throw new ApiError(
      404,
      "No es abonado activo o no tiene Fierabono verificado",
      true,
      "NOT_SUBSCRIBER",
    );
  }

  const nombre =
    (data.nombre as string | undefined)?.trim() ||
    (data.displayName as string | undefined)?.trim() ||
    "Abonado";
  const email = (data.email as string | undefined)?.trim() ?? "";

  return {
    memberId: userDocument.snap.id,
    nombre,
    email,
    isSubscriber: true,
    event: verification?.event,
    season: verification?.season,
    benefits: buildBenefitStatuses(verification),
  };
};

export const consumeAbonadoBenefit = async (params: {
  memberId: string;
  benefitId: string;
  ventaId: string;
}): Promise<ConsumeAbonadoBenefitResult> => {
  assertAppOficialReady();

  const trimmedId = params.memberId.trim();
  const benefitId = params.benefitId.trim();
  const ventaId = params.ventaId.trim();

  if (!trimmedId) {
    throw new ApiError(400, "ID de abonado inválido", true, "INVALID_MEMBER_ID");
  }
  if (!benefitId) {
    throw new ApiError(400, "Beneficio inválido", true, "INVALID_BENEFIT_ID");
  }
  if (!ventaId) {
    throw new ApiError(400, "ID de venta inválido", true, "INVALID_VENTA_ID");
  }

  const definition = getBenefitDefinition(benefitId);
  if (!definition) {
    throw new ApiError(404, "Beneficio no encontrado", true, "BENEFIT_NOT_FOUND");
  }

  const userDocument = await getUserDocumentByUid(trimmedId);
  if (!userDocument) {
    throw new ApiError(404, "Usuario no encontrado", true, "MEMBER_NOT_FOUND");
  }

  const data = userDocument.snap.data() ?? {};
  const verification = (data.seasonPassVerification ?? {}) as SeasonPassVerification;

  if (verification.isSubscriber !== true) {
    throw new ApiError(
      403,
      "El usuario ya no es abonado activo",
      true,
      "NOT_SUBSCRIBER",
    );
  }

  // TEMP: revert to once per jornada after testing — skip consume tracking
  if (ABONADO_BENEFIT_ONCE_PER_VENTA) {
    return {
      memberId: userDocument.snap.id,
      benefitId,
      ventaId,
      consumedAt: new Date().toISOString(),
    };
  }

  const consumed = { ...(verification.posBeneficiosConsumidos ?? {}) };
  const existing = consumed[benefitId];
  if (existing?.consumedAt) {
    throw new ApiError(
      409,
      "Este beneficio ya fue consumido",
      true,
      "BENEFIT_ALREADY_CONSUMED",
    );
  }

  const consumedAt = admin.firestore.Timestamp.now();
  consumed[benefitId] = { ventaId, consumedAt };

  await userDocument.ref.update({
    seasonPassVerification: {
      ...verification,
      posBeneficiosConsumidos: consumed,
    },
  });

  return {
    memberId: userDocument.snap.id,
    benefitId,
    ventaId,
    consumedAt: consumedAt.toDate().toISOString(),
  };
};
