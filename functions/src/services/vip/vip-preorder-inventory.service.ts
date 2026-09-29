import { Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../../config/firestore.constants";
import { getVipBusinessDate } from "../../config/vip.config";
import {
  isVipPreorder,
  VipOrder,
  VipOrderStatus,
  VipPaymentStatus,
  VipReservationStatus,
} from "../../models/vip.model";
import { buildJornadaId } from "../asignacion-caja.service";
import {
  applyDeferredVipStock,
  shouldSettleDeferredPreorder,
} from "./vip-inventory.service";

type DocData = FirebaseFirestore.DocumentData;

const col = (name: string) => firestorePos.collection(name);
const orderCol = () => col(COLLECTIONS.VIP_ORDERS);

export const vipSaleDocId = (
  orderId: string,
  fulfillment: VipOrder["fulfillments"][number],
  siblings: VipOrder["fulfillments"],
): string => {
  const sameConcession = siblings.filter((row) => row.concessionId === fulfillment.concessionId);
  return sameConcession.length > 1
    ? `vip_${orderId}_${fulfillment.concessionId}_${fulfillment.sucursalId}`
    : `vip_${orderId}_${fulfillment.concessionId}`;
};

const reservationStockTaken = (data: DocData | undefined): boolean => {
  if (!data) return false;
  if (data.inventoryDeferred === true) return data.inventoryApplied === true;
  return data.inventoryApplied !== false;
};

export const reservationAwaitingInventory = (data: DocData | undefined): boolean =>
  data?.inventoryDeferred === true && data?.inventoryApplied !== true &&
  data?.status === VipReservationStatus.CONFIRMED;

const logSettleFailure = (inventarioId: string, error: unknown) => {
  console.error("vip_deferred_inventory_settle_failed", {
    inventarioId,
    message: error instanceof Error ? error.message : "unknown",
  });
};

const writeFulfillmentSale = (
  tx: FirebaseFirestore.Transaction,
  order: VipOrder,
  fulfillment: VipOrder["fulfillments"][number],
  now: FirebaseFirestore.Timestamp,
) => {
  const preorder = isVipPreorder(order) ? order.preorder : null;
  const saleId = vipSaleDocId(order.id, fulfillment, order.fulfillments);
  const saleRef = col(COLLECTIONS.COMPROBANTES_VENTA).doc(saleId);
  const jornadaId = preorder
    ? buildJornadaId(preorder.matchDate, preorder.jornadaNumero, "varonil")
    : order.jornadaId;
  tx.set(saleRef, {
    ventaId: saleId,
    vipOrderId: order.id,
    vipOrderNumber: order.orderNumber,
    vipOrderType: preorder ? "PREORDER" : "IMMEDIATE",
    ...(preorder ? { vipMatchId: preorder.matchId, vipScheduledFor: preorder.windowStartAt } : {}),
    concesionId: fulfillment.concessionId,
    sucursalId: fulfillment.sucursalId,
    inventarioId: fulfillment.inventoryId,
    jornadaId,
    metodoPago: "tarjeta",
    source: "VIP",
    channel: "VIP_DELIVERY",
    total: fulfillment.subtotal,
    montoTarjeta: fulfillment.subtotal,
    vipOrderTotal: order.total,
    paymentIntentId: order.payment.paymentIntentId,
    cajaId: null,
    cajaNombre: "VIP",
    idUser: null,
    cajeroNombre: "VIP Stripe",
    lineasVenta: order.items
      .filter((row) => fulfillment.itemIds.includes(row.id))
      .map((item) => ({
        producto: item.productId,
        cantidad: item.quantity,
        precio_actual: item.unitPrice,
        subtotal: item.lineTotal,
      })),
    fecha: now,
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
  for (const item of order.items.filter((row) => fulfillment.itemIds.includes(row.id))) {
    tx.set(saleRef.collection(SUBCOLLECTIONS.DETALLE).doc(item.id), {
      producto: item.productId,
      nombre: item.name,
      cantidad: item.quantity,
      precio_actual: item.unitPrice,
      subtotal: item.lineTotal,
      selectedOptions: item.selectedOptions,
      extras: item.extras,
      notes: item.notes,
    }, { merge: true });
  }
};

/**
 * Applies paid, not-yet-posted preorders onto one inventory header.
 * Writes the sale receipt only after every draw of that fulfillment is in stock.
 */
export const applyDeferredVipInventory = async (inventoryId: string): Promise<number> => {
  const trimmed = inventoryId.trim();
  if (!trimmed) return 0;
  const snap = await col(COLLECTIONS.VIP_RESERVATIONS).where("inventoryId", "==", trimmed).get();
  const orderIds = [...new Set(
    snap.docs
      .filter((doc) => reservationAwaitingInventory(doc.data()))
      .map((doc) => String(doc.data()?.orderId || ""))
      .filter(Boolean),
  )];
  let applied = 0;
  for (const orderId of orderIds) {
    applied += await settleOrderOnInventory(orderId, trimmed);
  }
  return applied;
};

const settleOrderOnInventory = async (orderId: string, inventoryId: string): Promise<number> => {
  const businessDate = getVipBusinessDate();
  return firestorePos.runTransaction(async (tx) => {
    const orderRef = orderCol().doc(orderId);
    const orderDoc = await tx.get(orderRef);
    if (!orderDoc.exists) return 0;
    const order = orderDoc.data() as VipOrder;
    if (order.payment.status !== VipPaymentStatus.PAID &&
        order.payment.status !== VipPaymentStatus.PARTIALLY_REFUNDED) {
      return 0;
    }
    if (order.status === VipOrderStatus.REFUNDED || order.status === VipOrderStatus.CANCELLED) return 0;

    const reservationSnap = await tx.get(
      col(COLLECTIONS.VIP_RESERVATIONS).where("orderId", "==", orderId),
    );
    const reservations = reservationSnap.docs.map((doc) => ({
      ref: doc.ref,
      data: doc.data() || {},
    }));
    const pending = reservations.filter((row) =>
      String(row.data.inventoryId || "") === inventoryId && reservationAwaitingInventory(row.data),
    );
    if (!pending.length) return 0;

    const header = await tx.get(col(COLLECTIONS.INVENTARIOS).doc(inventoryId));
    const headerOpen = Boolean(header.exists && header.data()?.activo === true);
    const stockDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    if (headerOpen) {
      for (const row of pending) {
        const productId = String(row.data.productId || "");
        if (!productId || stockDocs.has(productId)) continue;
        stockDocs.set(
          productId,
          await tx.get(
            col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
              .collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId),
          ),
        );
      }
    }

    const applicable = headerOpen
      ? pending.filter((row) => {
        const productId = String(row.data.productId || "");
        const stock = stockDocs.get(productId);
        const inicial = stock?.exists ? Number(stock.data()?.cantidad_inicial ?? 0) : 0;
        const matchDate = String(row.data.matchDate || row.data.jornadaFecha || "");
        if (!stock?.exists) return shouldSettleDeferredPreorder(0, matchDate, businessDate) && businessDate >= matchDate;
        return shouldSettleDeferredPreorder(inicial, matchDate, businessDate);
      })
      : [];

    const saleRefs = order.fulfillments.map((fulfillment) => ({
      fulfillment,
      ref: col(COLLECTIONS.COMPROBANTES_VENTA).doc(vipSaleDocId(order.id, fulfillment, order.fulfillments)),
    }));
    const saleDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const sale of saleRefs) {
      saleDocs.set(sale.ref.path, await tx.get(sale.ref));
    }

    if (!applicable.length) return 0;

    const now = Timestamp.now();
    const appliedPaths = new Set<string>();
    const running = new Map<string, number>();
    let applied = 0;
    for (const row of applicable) {
      const productId = String(row.data.productId || "");
      const quantity = Number(row.data.quantity || 0);
      if (!productId || !Number.isInteger(quantity) || quantity <= 0) continue;
      const stock = stockDocs.get(productId);
      const stockRef = col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
        .collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId);
      let current = 0;
      if (running.has(productId)) {
        current = Number(running.get(productId));
      } else if (stock?.exists) {
        current = Number(stock.data()?.cantidad_final ?? stock.data()?.cantidad_inicial ?? 0);
      }
      const next = applyDeferredVipStock(current, quantity);
      running.set(productId, next);
      if (!stock?.exists) {
        tx.set(stockRef, {
          producto_id: productId,
          cantidad_inicial: 0,
          cantidad_final: next,
          updatedAt: now,
        });
      } else {
        tx.update(stockRef, { cantidad_final: next, updatedAt: now });
      }
      tx.create(
        col(COLLECTIONS.INVENTARIOS).doc(inventoryId).collection(SUBCOLLECTIONS.MOVIMIENTOS).doc(),
        {
          tipo: "VENTA",
          producto_id: productId,
          cantidad: -quantity,
          cantidad_anterior: current,
          cantidad_nueva: next,
          sucursal_id: row.data.sucursalId ?? null,
          ventaId: order.id,
          vipOrderId: order.id,
          motivo: "Preventa VIP aplicada al inventario del partido",
          createdAt: now,
        },
      );
      tx.update(row.ref, {
        inventoryApplied: true,
        updatedAt: now,
      });
      appliedPaths.add(row.ref.path);
      applied += 1;
    }

    const isApplied = (row: { ref: FirebaseFirestore.DocumentReference; data: DocData }) =>
      appliedPaths.has(row.ref.path) || row.data.inventoryApplied === true || row.data.inventoryDeferred !== true;

    let allRecorded = true;
    for (const sale of saleRefs) {
      const draws = reservations.filter((row) =>
        String(row.data.inventoryId || "") === sale.fulfillment.inventoryId &&
        String(row.data.concessionId || "") === sale.fulfillment.concessionId &&
        row.data.status !== VipReservationStatus.RELEASED &&
        row.data.status !== VipReservationStatus.RESTORED,
      );
      const ready = draws.length > 0 && draws.every(isApplied);
      if (!ready) {
        allRecorded = false;
        continue;
      }
      const existing = saleDocs.get(sale.ref.path);
      if (existing?.exists && existing.data()?.vipOrderId) continue;
      writeFulfillmentSale(tx, order, sale.fulfillment, now);
    }
    if (allRecorded && order.salesRecorded !== true) {
      tx.update(orderRef, {
        salesRecorded: true,
        inventoryConfirmed: true,
        updatedAt: now,
      });
    }
    return applied;
  });
};

export const settleDeferredVipSalesForCorte = async (
  filters: { inventarioId?: string; sucursalId?: string },
): Promise<void> => {
  const ids = new Set<string>();
  if (filters.inventarioId) ids.add(filters.inventarioId);
  if (filters.sucursalId) {
    const snap = await col(COLLECTIONS.INVENTARIOS)
      .where("sucursal_id", "==", filters.sucursalId)
      .limit(20)
      .get();
    for (const doc of snap.docs) {
      if (doc.data()?.activo === true) ids.add(doc.id);
    }
  }
  for (const id of ids) {
    try {
      await applyDeferredVipInventory(id);
    } catch (error) {
      logSettleFailure(id, error);
    }
  }
};

export const settleInventoryQuietly = async (inventarioId: string | null | undefined): Promise<void> => {
  if (!inventarioId) return;
  try {
    await applyDeferredVipInventory(inventarioId);
  } catch (error) {
    logSettleFailure(inventarioId, error);
  }
};

/** Legacy immediate reservations already decremented stock. Deferred ones only after apply. */
export const vipReservationDecrementedStock = reservationStockTaken;

export const preorderLinePrice = (
  inventoryPrice: unknown,
  catalogPrice: unknown,
): number => {
  const fromInventory = Number(inventoryPrice);
  if (inventoryPrice !== undefined && inventoryPrice !== null && Number.isFinite(fromInventory) && fromInventory >= 0) {
    return fromInventory;
  }
  return Number(catalogPrice);
};
