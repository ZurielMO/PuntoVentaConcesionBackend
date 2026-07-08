import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { logMovimientoInTransaction } from "./inventario.service";
import {
  buildJornadaId,
  resolveCajaActivaParaVendedor,
} from "./asignacion-caja.service";
import { getUserById } from "./user.service";
import { getComboById } from "./combo.service";
import {
  calcularCanjePuntos,
  calcularMontoDesdePuntos,
  cancelRedemptionHold,
  confirmRedemptionHold,
  createRedemptionHold,
  getClubMember,
} from "./loyalty-points.service";
import type { ComboProducto } from "../models";

const col = () => firestorePos.collection(COLLECTIONS.COMPROBANTES_VENTA);
const inventariosCol = () => firestorePos.collection(COLLECTIONS.INVENTARIOS);
const productsCol = () => firestorePos.collection(COLLECTIONS.PRODUCTS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> & { id: string } => ({
  id: doc.id,
  ...doc.data(),
});

interface DetalleProductoInput {
  producto?: string;
  combo?: string;
  cantidad: number;
  precio_actual?: number;
}

export interface AbonadoVentaInput {
  benefitId: string;
  titulo: string;
  montoTotal: number;
  montoDescuento: number;
  unidadesGratis: number;
}

interface ResolvedLinea {
  producto: string;
  cantidad: number;
  precio_actual: number;
  subtotal: number;
}

const computeTotal = (lineas: { subtotal: number }[]) =>
  Math.round(lineas.reduce((acc, l) => acc + l.subtotal, 0) * 100) / 100;

/** Agrupa líneas por producto (combo + productos sueltos pueden repetir el mismo id). */
export const mergeResolvedLineas = (lineas: ResolvedLinea[]): ResolvedLinea[] => {
  const byProduct = new Map<string, ResolvedLinea>();

  for (const linea of lineas) {
    const existing = byProduct.get(linea.producto);
    if (!existing) {
      byProduct.set(linea.producto, { ...linea });
      continue;
    }

    const cantidad = existing.cantidad + linea.cantidad;
    const subtotal =
      Math.round((existing.subtotal + linea.subtotal) * 100) / 100;
    const precio_actual =
      cantidad > 0 ? Math.round((subtotal / cantidad) * 100) / 100 : 0;

    byProduct.set(linea.producto, {
      producto: linea.producto,
      cantidad,
      precio_actual,
      subtotal,
    });
  }

  return Array.from(byProduct.values());
};

const unwrapTransactionError = (error: unknown): never => {
  if (error instanceof ApiError) {
    throw error;
  }

  const nested = (error as { cause?: unknown })?.cause;
  if (nested instanceof ApiError) {
    throw nested;
  }

  throw error;
};

/** @internal exported for unit tests */
export const resolvePrecio = (
  inputPrice: number | undefined,
  invProducto: FirebaseFirestore.DocumentData | undefined,
  catalogProduct: FirebaseFirestore.DocumentData | undefined,
): number => {
  // POS envía precio_actual al cobrar (incluye descuentos abonado); tiene prioridad.
  if (inputPrice != null && !Number.isNaN(Number(inputPrice))) {
    return Number(inputPrice);
  }
  if (invProducto?.precio_jornada != null) {
    return Number(invProducto.precio_jornada);
  }
  if (catalogProduct?.precio != null) {
    return Number(catalogProduct.precio);
  }
  throw new ApiError(
    400,
    "No se pudo determinar el precio del producto",
    true,
    "INVALID_PRICE",
  );
};

const expandComboToLineas = async (
  comboId: string,
  cantidad: number,
  inputPrice?: number,
): Promise<ResolvedLinea[]> => {
  const combo = await getComboById(comboId);
  const comboData = combo as {
    activo?: boolean;
    precio?: number;
    productos?: ComboProducto[];
  };

  if (comboData.activo === false) {
    throw new ApiError(400, "El combo no está activo", true, "INVALID_COMBO");
  }

  const componentes = comboData.productos ?? [];
  if (componentes.length === 0) {
    throw new ApiError(400, "El combo no tiene productos", true, "INVALID_COMBO");
  }

  const unitPrice =
    inputPrice != null ? Number(inputPrice) : Number(comboData.precio ?? 0);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new ApiError(
      400,
      "No se pudo determinar el precio del combo",
      true,
      "INVALID_PRICE",
    );
  }

  const comboTotal = Math.round(unitPrice * cantidad * 100) / 100;
  const expanded = componentes.map((componente) => {
    const productoId = componente.producto_id?.trim();
    if (!productoId) {
      throw new ApiError(
        400,
        "El combo tiene un componente sin producto",
        true,
        "INVALID_COMBO",
      );
    }
    return {
      producto: productoId,
      cantidad: componente.cantidad * cantidad,
    };
  });

  const weighted = await Promise.all(
    expanded.map(async (linea) => {
      const catalogDoc = await productsCol().doc(linea.producto).get();
      const catalogPrice = Number(catalogDoc.data()?.precio ?? 1);
      const weight = catalogPrice * linea.cantidad;
      return { ...linea, weight };
    }),
  );

  const totalWeight = weighted.reduce((acc, linea) => acc + linea.weight, 0);
  const lineas: ResolvedLinea[] = [];
  let assigned = 0;

  weighted.forEach((linea, index) => {
    let subtotal: number;
    if (index === weighted.length - 1) {
      subtotal = Math.round((comboTotal - assigned) * 100) / 100;
    } else if (totalWeight > 0) {
      subtotal = Math.round(comboTotal * (linea.weight / totalWeight) * 100) / 100;
      assigned += subtotal;
    } else {
      subtotal = Math.round((comboTotal / weighted.length) * 100) / 100;
      assigned += subtotal;
    }

    const precioActual =
      linea.cantidad > 0
        ? Math.round((subtotal / linea.cantidad) * 100) / 100
        : 0;

    lineas.push({
      producto: linea.producto,
      cantidad: linea.cantidad,
      precio_actual: precioActual,
      subtotal,
    });
  });

  return lineas;
};

const resolveLineas = async (
  inventarioId: string,
  productos: DetalleProductoInput[],
): Promise<ResolvedLinea[]> => {
  const lineas: ResolvedLinea[] = [];

  for (const item of productos) {
    if (item.combo) {
      const expanded = await expandComboToLineas(
        item.combo,
        item.cantidad,
        item.precio_actual,
      );
      lineas.push(...expanded);
      continue;
    }

    if (!item.producto) {
      throw new ApiError(
        400,
        "Cada línea debe incluir producto o combo",
        true,
        "INVALID_LINE",
      );
    }

    const invProdDoc = await inventariosCol()
      .doc(inventarioId)
      .collection(SUBCOLLECTIONS.PRODUCTOS)
      .doc(item.producto)
      .get();

    const catalogDoc = await productsCol().doc(item.producto).get();
    const precio = resolvePrecio(
      item.precio_actual,
      invProdDoc.data(),
      catalogDoc.data(),
    );

    lineas.push({
      producto: item.producto,
      cantidad: item.cantidad,
      precio_actual: precio,
      subtotal: Math.round(item.cantidad * precio * 100) / 100,
    });
  }

  return lineas;
};

const resolveCajaForVenta = async (params: {
  idUser: string;
  sucursalId: string;
  inventarioId: string;
}) => {
  const invDoc = await inventariosCol().doc(params.inventarioId).get();
  if (!invDoc.exists) {
    throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
  }
  const inv = invDoc.data() ?? {};
  const jornadaId = buildJornadaId(
    String(inv.jornada_fecha ?? ""),
    Number(inv.jornada_numero ?? 0),
  );

  let fallbackCajaId: string | null = null;
  let cajeroNombre = "Cajero";
  try {
    const profile = await getUserById(params.idUser);
    fallbackCajaId = (profile.cajaId as string | null | undefined) ?? null;
    cajeroNombre = (profile.nombre as string) ?? cajeroNombre;
  } catch {
    // Perfil opcional si uid no está en users
  }

  const caja = await resolveCajaActivaParaVendedor({
    vendedorUid: params.idUser,
    jornadaId,
    sucursalId: params.sucursalId,
    fallbackCajaId,
  });

  if (!caja) {
    throw new ApiError(
      400,
      "Debes tener una caja asignada para registrar ventas",
      true,
      "MISSING_CAJA",
    );
  }

  return { jornadaId, caja, cajeroNombre };
};

export type MetodoPago =
  | "efectivo"
  | "tarjeta"
  | "puntos"
  | "puntos+efectivo"
  | "puntos+tarjeta";

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const resolveMontosPago = (params: {
  total: number;
  metodoPago: MetodoPago;
  puntosUsados: number;
  montoPuntos: number;
}): { montoEfectivo: number; montoTarjeta: number; montoPuntos: number } => {
  const { total, metodoPago, puntosUsados, montoPuntos } = params;

  if (puntosUsados <= 0) {
    if (metodoPago === "tarjeta") {
      return { montoEfectivo: 0, montoTarjeta: total, montoPuntos: 0 };
    }
    return { montoEfectivo: total, montoTarjeta: 0, montoPuntos: 0 };
  }

  const restante = roundMoney(Math.max(0, total - montoPuntos));
  if (metodoPago === "puntos+tarjeta") {
    return { montoEfectivo: 0, montoTarjeta: restante, montoPuntos };
  }
  if (metodoPago === "puntos") {
    return { montoEfectivo: 0, montoTarjeta: 0, montoPuntos };
  }
  return { montoEfectivo: restante, montoTarjeta: 0, montoPuntos };
};

const validatePagoConPuntos = async (params: {
  total: number;
  metodoPago: MetodoPago;
  puntosUsados: number;
  memberId?: string;
}): Promise<{ montoPuntos: number; memberId: string }> => {
  const { total, metodoPago, puntosUsados, memberId } = params;

  if (puntosUsados <= 0 && !metodoPago.startsWith("puntos")) {
    return { montoPuntos: 0, memberId: memberId?.trim() ?? "" };
  }

  const trimmedMemberId = memberId?.trim();
  if (!trimmedMemberId) {
    throw new ApiError(
      400,
      "Se requiere socio para pagar con puntos",
      true,
      "MEMBER_REQUIRED",
    );
  }

  const member = await getClubMember(trimmedMemberId);
  const canje = calcularCanjePuntos({
    total,
    puntosDisponibles: member.puntosActuales,
    puntosSolicitados: puntosUsados,
  });

  if (canje.puntosUsados !== puntosUsados) {
    throw new ApiError(
      400,
      "Cantidad de puntos inválida para este total",
      true,
      "INVALID_POINTS",
    );
  }

  if (canje.puntosUsados <= 0) {
    throw new ApiError(
      400,
      "El socio no tiene puntos suficientes",
      true,
      "INSUFFICIENT_POINTS",
    );
  }

  const expectedMontoPuntos = calcularMontoDesdePuntos(canje.puntosUsados);
  if (metodoPago === "puntos" && canje.restante > 0) {
    throw new ApiError(
      400,
      "Los puntos no cubren el total de la venta",
      true,
      "INSUFFICIENT_POINTS",
    );
  }

  if (metodoPago.startsWith("puntos") && metodoPago !== "puntos" && canje.restante <= 0) {
    throw new ApiError(
      400,
      "El método de pago del remanente no aplica",
      true,
      "INVALID_PAYMENT_METHOD",
    );
  }

  if (!metodoPago.startsWith("puntos")) {
    throw new ApiError(
      400,
      "metodoPago inconsistente con puntosUsados",
      true,
      "INVALID_PAYMENT_METHOD",
    );
  }

  return { montoPuntos: expectedMontoPuntos, memberId: trimmedMemberId };
};

export const createDetalleVenta = async (params: {
  ventaId: string;
  concesionId: string;
  sucursalId: string;
  inventarioId: string;
  idUser?: string;
  productos: DetalleProductoInput[];
  metodoPago?: MetodoPago;
  puntosUsados?: number;
  memberId?: string;
  abonado?: AbonadoVentaInput;
}) => {
  if (!params.idUser) {
    throw new ApiError(401, "No autenticado", true, "UNAUTHENTICATED");
  }

  const { jornadaId, caja, cajeroNombre } = await resolveCajaForVenta({
    idUser: params.idUser,
    sucursalId: params.sucursalId,
    inventarioId: params.inventarioId,
  });

  const lineas = mergeResolvedLineas(
    await resolveLineas(params.inventarioId, params.productos),
  );
  const total = computeTotal(lineas);
  const metodoPago = params.metodoPago ?? "efectivo";
  const puntosUsados = Math.max(0, Math.trunc(params.puntosUsados ?? 0));

  const pagoPuntos = await validatePagoConPuntos({
    total,
    metodoPago,
    puntosUsados,
    memberId: params.memberId,
  });
  const montos = resolveMontosPago({
    total,
    metodoPago,
    puntosUsados,
    montoPuntos: pagoPuntos.montoPuntos,
  });

  const comprobanteRef = col().doc();
  const inventarioRef = inventariosCol().doc(params.inventarioId);

  let redemptionHold:
    | {
        redemptionId: string;
        memberId: string;
        puntosCanjeados: number;
        descripcion: string;
      }
    | null = null;

  if (puntosUsados > 0 && pagoPuntos.memberId) {
    redemptionHold = await createRedemptionHold({
      memberId: pagoPuntos.memberId,
      puntos: puntosUsados,
      ventaId: params.ventaId,
    });
  }

  try {
    await firestorePos.runTransaction(async (tx) => {
      const invDoc = await tx.get(inventarioRef);
      if (!invDoc.exists || invDoc.data()?.activo === false) {
        throw new ApiError(404, "Inventario no encontrado", true, "NOT_FOUND");
      }

      const prodRefs = new Map<string, FirebaseFirestore.DocumentReference>();
      const stockByProduct = new Map<string, number>();

      for (const linea of lineas) {
        if (prodRefs.has(linea.producto)) {
          continue;
        }

        const prodRef = inventarioRef
          .collection(SUBCOLLECTIONS.PRODUCTOS)
          .doc(linea.producto);
        const prodDoc = await tx.get(prodRef);
        if (!prodDoc.exists) {
          throw new ApiError(
            400,
            `Producto ${linea.producto} no está en el inventario`,
            true,
            "PRODUCT_NOT_IN_INVENTORY",
          );
        }

        const data = prodDoc.data() ?? {};
        const cantidadInicial = Number(data.cantidad_inicial ?? 0);
        const cantidadFinal = Number(data.cantidad_final ?? cantidadInicial);

        prodRefs.set(linea.producto, prodRef);
        stockByProduct.set(linea.producto, cantidadFinal);
      }

      for (const linea of lineas) {
        const prodRef = prodRefs.get(linea.producto);
        if (!prodRef) {
          throw new ApiError(
            400,
            `Producto ${linea.producto} no está en el inventario`,
            true,
            "PRODUCT_NOT_IN_INVENTORY",
          );
        }

        const cantidadFinal = stockByProduct.get(linea.producto) ?? 0;
        if (linea.cantidad > cantidadFinal) {
          throw new ApiError(
            409,
            `Stock insuficiente para el producto ${linea.producto}`,
            true,
            "INSUFFICIENT_STOCK",
          );
        }

        const nuevaCantidad = cantidadFinal - linea.cantidad;
        stockByProduct.set(linea.producto, nuevaCantidad);

        tx.set(
          prodRef,
          {
            cantidad_final: nuevaCantidad,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        logMovimientoInTransaction(tx, params.inventarioId, {
          tipo: "VENTA",
          producto_id: linea.producto,
          cantidad: -linea.cantidad,
          cantidad_anterior: cantidadFinal,
          cantidad_nueva: nuevaCantidad,
          sucursal_id: params.sucursalId,
          cajaId: caja.cajaId,
          cajaNombre: caja.cajaNombre,
          idUser: params.idUser ?? null,
          ventaId: params.ventaId,
        });
      }

      const lineasVenta = params.productos.map((item) => {
        const linea: Record<string, unknown> = {
          cantidad: item.cantidad,
        };
        if (item.combo) {
          linea.combo = item.combo;
        } else if (item.producto) {
          linea.producto = item.producto;
        }
        if (item.precio_actual != null) {
          linea.precio_actual = item.precio_actual;
        }
        return linea;
      });

      const abonadoPayload =
        params.abonado && params.abonado.montoDescuento > 0
          ? {
              benefitId: params.abonado.benefitId,
              titulo: params.abonado.titulo,
              montoTotal: roundMoney(params.abonado.montoTotal),
              montoDescuento: roundMoney(params.abonado.montoDescuento),
              unidadesGratis: params.abonado.unidadesGratis,
            }
          : null;

      tx.set(comprobanteRef, {
        ventaId: params.ventaId,
        concesionId: params.concesionId,
        sucursalId: params.sucursalId,
        inventarioId: params.inventarioId,
        jornadaId,
        cajaId: caja.cajaId,
        cajaNombre: caja.cajaNombre,
        idUser: params.idUser ?? null,
        cajeroNombre,
        metodoPago,
        total,
        lineasVenta,
        abonado: abonadoPayload,
        puntosUsados: puntosUsados > 0 ? puntosUsados : null,
        montoPuntos: montos.montoPuntos > 0 ? montos.montoPuntos : null,
        montoEfectivo: montos.montoEfectivo > 0 ? montos.montoEfectivo : null,
        montoTarjeta: montos.montoTarjeta > 0 ? montos.montoTarjeta : null,
        memberId: pagoPuntos.memberId || null,
        fecha: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const detalleRef = comprobanteRef.collection(SUBCOLLECTIONS.DETALLE);
      lineas.forEach((linea) => {
        tx.set(detalleRef.doc(), linea);
      });
    });
  } catch (error) {
    if (redemptionHold) {
      await cancelRedemptionHold({
        redemptionId: redemptionHold.redemptionId,
        ventaId: params.ventaId,
      });
    }
    unwrapTransactionError(error);
  }

  if (redemptionHold) {
    try {
      await confirmRedemptionHold({
        redemptionId: redemptionHold.redemptionId,
        ventaId: params.ventaId,
        memberId: redemptionHold.memberId,
        puntosCanjeados: redemptionHold.puntosCanjeados,
        descripcion: redemptionHold.descripcion,
      });
    } catch (error) {
      await cancelRedemptionHold({
        redemptionId: redemptionHold.redemptionId,
        ventaId: params.ventaId,
      });
      if (error instanceof ApiError) {
        throw new ApiError(
          error.statusCode,
          "Venta registrada pero no se pudieron canjear los puntos",
          true,
          "POINTS_REDEEM_FAILED",
        );
      }
      throw new ApiError(
        502,
        "Venta registrada pero no se pudieron canjear los puntos",
        true,
        "POINTS_REDEEM_FAILED",
      );
    }
  }

  return getDetalleVentaById(comprobanteRef.id);
};

export const getDetalleVentaById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Comprobante no encontrado", true, "NOT_FOUND");
  }
  const detalleSnap = await col()
    .doc(id)
    .collection(SUBCOLLECTIONS.DETALLE)
    .get();
  return { ...toData(doc), detalle: detalleSnap.docs.map(toData) };
};

export const listDetalleVentas = async (filters: {
  concesionId?: string;
  sucursalId?: string;
  idUser?: string;
  cajaId?: string;
  inventarioId?: string;
}) => {
  let query: FirebaseFirestore.Query = col();
  if (filters.concesionId) {
    query = query.where("concesionId", "==", filters.concesionId);
  } else if (filters.inventarioId) {
    query = query.where("inventarioId", "==", filters.inventarioId);
  }

  const snap = await query.get();
  let results = snap.docs.map(toData);

  if (filters.inventarioId && filters.concesionId) {
    results = results.filter((r) => r.inventarioId === filters.inventarioId);
  }
  if (filters.sucursalId) {
    results = results.filter((r) => r.sucursalId === filters.sucursalId);
  }
  if (filters.cajaId) {
    results = results.filter((r) => r.cajaId === filters.cajaId);
  }
  if (filters.idUser) {
    results = results.filter((r) => r.idUser === filters.idUser);
  }

  results.sort((a, b) => {
    const ta = (a.fecha as { _seconds?: number })?._seconds
      ?? (a.createdAt as { _seconds?: number })?._seconds
      ?? 0;
    const tb = (b.fecha as { _seconds?: number })?._seconds
      ?? (b.createdAt as { _seconds?: number })?._seconds
      ?? 0;
    return tb - ta;
  });

  return results;
};

/** Carga la subcolección detalle de cada comprobante (p. ej. para corte/resumen). */
export const attachDetalleToComprobantes = async (
  comprobantes: Array<Record<string, unknown> & { id: string }>,
): Promise<Array<Record<string, unknown> & { id: string }>> => {
  if (comprobantes.length === 0) {
    return [];
  }

  return Promise.all(
    comprobantes.map(async (comprobante) => {
      const detalleSnap = await col()
        .doc(comprobante.id)
        .collection(SUBCOLLECTIONS.DETALLE)
        .get();
      return {
        ...comprobante,
        detalle: detalleSnap.docs.map(toData),
      };
    }),
  );
};

export const updateDetalleVenta = async (
  id: string,
  productos: DetalleProductoInput[],
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Comprobante no encontrado", true, "NOT_FOUND");
  }

  const inventarioId = doc.data()?.inventarioId as string;
  const lineas = mergeResolvedLineas(await resolveLineas(inventarioId, productos));
  const total = computeTotal(lineas);

  const detalleRef = ref.collection(SUBCOLLECTIONS.DETALLE);
  const existing = await detalleRef.get();
  const batch = firestorePos.batch();
  existing.docs.forEach((d) => batch.delete(d.ref));
  lineas.forEach((linea) => batch.set(detalleRef.doc(), linea));
  batch.update(ref, { total, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  return getDetalleVentaById(id);
};

export const resolveCajaContextForUser = resolveCajaForVenta;
