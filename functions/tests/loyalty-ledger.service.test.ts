/**
 * El ledger se prueba contra un Firestore en memoria. Lo que importa aquí es
 * que el saldo canónico (`loyalty_wallets`), su espejo legacy
 * (`usuariosApp.puntosActuales`), el asiento oficial y el comprobante POS
 * queden siempre coherentes entre sí, y que reintentar una venta —desde el POS
 * o desde BackendCL— no mueva puntos dos veces.
 */
const mockStore = new Map<string, Record<string, unknown>>();

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
  Timestamp: { now: () => "TS_NOW" },
}));

jest.mock("../src/config/app.firebase", () => {
  let autoId = 0;

  const snapFor = (path: string) => {
    const data = mockStore.get(path);
    return {
      exists: data !== undefined,
      id: path.split("/").pop() as string,
      data: () => data,
      get ref() {
        return refFor(path);
      },
    };
  };

  const refFor = (path: string): Record<string, unknown> => ({
    path,
    id: path.split("/").pop() as string,
    get: async () => snapFor(path),
    collection: (name: string) => collectionFor(`${path}/${name}`),
  });

  const collectionFor = (base: string) => ({
    doc: (id?: string) => refFor(`${base}/${id ?? `auto-${++autoId}`}`),
    where: (field: string, _op: string, value: unknown) => ({
      limit: (_n: number) => ({
        get: async () => {
          const depth = base.split("/").length + 1;
          const docs = Array.from(mockStore.entries())
            .filter(
              ([path, data]) =>
                path.startsWith(`${base}/`) &&
                path.split("/").length === depth &&
                data[field] === value,
            )
            .map(([path]) => snapFor(path));
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
  });

  return {
    USUARIOS_APP_COLLECTION: "usuariosApp",
    firestoreApp: {
      collection: (name: string) => collectionFor(name),
      runTransaction: async <T>(
        fn: (tx: Record<string, unknown>) => Promise<T>,
      ): Promise<T> => {
        const tx = {
          get: async (ref: { path: string }) => snapFor(ref.path),
          // `merge` se respeta de verdad porque el servicio escribe el saldo
          // con merge sobre documentos que tienen más campos (el perfil del
          // socio); reemplazarlos entero ocultaría regresiones.
          set: (
            ref: { path: string },
            data: Record<string, unknown>,
            options?: { merge?: boolean },
          ) => {
            const current = options?.merge ? mockStore.get(ref.path) : undefined;
            mockStore.set(ref.path, { ...current, ...data });
          },
          update: (ref: { path: string }, data: Record<string, unknown>) => {
            const current = mockStore.get(ref.path);
            if (!current) {
              throw new Error(`update sobre documento inexistente: ${ref.path}`);
            }
            mockStore.set(ref.path, { ...current, ...data });
          },
        };
        return fn(tx);
      },
    },
  };
});

import {
  accrueSalePoints,
  cancelSalePointsHold,
  confirmSalePointsHold,
  holdSalePoints,
  readAvailablePoints,
  resolveUsuarioAppRef,
} from "../src/services/loyalty-ledger.service";

const USER_PATH = "usuariosApp/uid-1";
const WALLET_PATH = "loyalty_wallets/uid-1";
const movPath = (id: string) => `${USER_PATH}/movimientos_puntos/${id}`;
const extPath = (ventaId: string) =>
  `loyalty_external_txn_index/STORE:pos-sale:${ventaId}`;

/** Saldo canónico: el que leen la racha, los bonos y la app. */
const wallet = () => mockStore.get(WALLET_PATH) ?? {};
const disponible = () => wallet().availablePoints as number | undefined;
const reservado = () => wallet().heldPoints as number | undefined;

/** Espejo legacy: debe seguir siempre al wallet, nunca ir por su cuenta. */
const espejo = () => mockStore.get(USER_PATH)?.puntosActuales as number | undefined;

const asientos = () =>
  Array.from(mockStore.entries())
    .filter(([path]) => path.startsWith("loyalty_transactions/"))
    .map(([, data]) => data);

const setWallet = (fields: Record<string, unknown>) => {
  mockStore.set(WALLET_PATH, {
    memberId: "uid-1",
    availablePoints: 0,
    heldPoints: 0,
    pendingPoints: 0,
    lifetimeEarnedPoints: 0,
    lifetimeRedeemedPoints: 0,
    level: "Bronce",
    ...fields,
  });
};

describe("loyalty-ledger.service", () => {
  beforeEach(() => {
    mockStore.clear();
    mockStore.set(USER_PATH, {
      uid: "uid-1",
      nombre: "Ana Socio",
      email: "ana@test.com",
      puntosActuales: 100,
    });
    setWallet({ availablePoints: 100, lifetimeEarnedPoints: 100 });
  });

  describe("resolveUsuarioAppRef", () => {
    it("encuentra al socio cuando el UID es el ID del documento", async () => {
      const usuario = await resolveUsuarioAppRef("uid-1");
      expect(usuario?.id).toBe("uid-1");
    });

    it("encuentra al socio por el campo uid cuando el ID del documento difiere", async () => {
      mockStore.set("usuariosApp/doc-interno", {
        uid: "uid-9",
        puntosActuales: 10,
      });

      const usuario = await resolveUsuarioAppRef("uid-9");
      expect(usuario?.id).toBe("doc-interno");
    });

    it("devuelve null si no existe", async () => {
      await expect(resolveUsuarioAppRef("uid-fantasma")).resolves.toBeNull();
    });
  });

  describe("readAvailablePoints", () => {
    it("lee el saldo del wallet y no el del espejo", async () => {
      mockStore.set(USER_PATH, {
        uid: "uid-1",
        puntosActuales: 999,
      });
      setWallet({ availablePoints: 42 });

      const usuario = await resolveUsuarioAppRef("uid-1");
      await expect(readAvailablePoints(usuario!)).resolves.toBe(42);
    });

    it("cae al espejo mientras el socio no tenga wallet", async () => {
      mockStore.delete(WALLET_PATH);

      const usuario = await resolveUsuarioAppRef("uid-1");
      await expect(readAvailablePoints(usuario!)).resolves.toBe(100);
    });
  });

  describe("accrueSalePoints", () => {
    it("mueve el saldo canónico, su espejo y deja el asiento oficial", async () => {
      const result = await accrueSalePoints({
        memberId: "uid-1",
        ventaId: "V-1",
        puntos: 32,
        descripcion: "Venta POS V-1",
        montoVenta: 320,
      });

      expect(result).toMatchObject({
        status: "APPLIED",
        puntosAsignados: 32,
        saldoAnterior: 100,
        puntosActuales: 132,
      });
      expect(disponible()).toBe(132);
      expect(espejo()).toBe(132);
      expect(wallet().lifetimeEarnedPoints).toBe(132);

      expect(asientos()).toHaveLength(1);
      expect(asientos()[0]).toMatchObject({
        memberId: "uid-1",
        type: "EARN",
        status: "CONFIRMED",
        channel: "STORE",
        points: 32,
        balanceBefore: 100,
        balanceAfter: 132,
        amountCents: 32000,
        externalTransactionId: "pos-sale:V-1",
      });

      expect(mockStore.get(extPath("V-1"))).toMatchObject({
        memberId: "uid-1",
        channel: "STORE",
      });
      expect(mockStore.get(movPath("pos_acc_V-1"))).toMatchObject({
        tipo: "ACUMULACION",
        puntos: 32,
        saldoAnterior: 100,
        saldoNuevo: 132,
        origen: "pos",
        origenId: "V-1",
        referencia: "V-1",
      });
    });

    it("acumula sobre el wallet aunque el espejo esté desfasado", async () => {
      // Es el escenario del incidente: el espejo se había quedado con un saldo
      // viejo. El wallet es el que manda, así que la venta parte de él.
      mockStore.set(USER_PATH, { uid: "uid-1", puntosActuales: 80 });
      setWallet({ availablePoints: 8 });

      const result = await accrueSalePoints({
        memberId: "uid-1",
        ventaId: "V-7",
        puntos: 13,
        descripcion: "Venta POS V-7",
      });

      expect(result.saldoAnterior).toBe(8);
      expect(result.puntosActuales).toBe(21);
      expect(disponible()).toBe(21);
      expect(espejo()).toBe(21);
    });

    it("inicializa el wallet desde el espejo la primera vez", async () => {
      mockStore.delete(WALLET_PATH);

      const result = await accrueSalePoints({
        memberId: "uid-1",
        ventaId: "V-8",
        puntos: 5,
        descripcion: "Venta POS V-8",
      });

      expect(result.saldoAnterior).toBe(100);
      expect(disponible()).toBe(105);
      expect(espejo()).toBe(105);
    });

    it("no vuelve a acreditar la misma venta", async () => {
      await accrueSalePoints({
        memberId: "uid-1",
        ventaId: "V-1",
        puntos: 32,
        descripcion: "Venta POS V-1",
      });
      const segunda = await accrueSalePoints({
        memberId: "uid-1",
        ventaId: "V-1",
        puntos: 32,
        descripcion: "Venta POS V-1",
      });

      expect(segunda.status).toBe("ALREADY_PROCESSED");
      expect(segunda.puntosActuales).toBe(132);
      expect(disponible()).toBe(132);
      expect(asientos()).toHaveLength(1);
    });

    it("no acredita una venta que BackendCL ya registró", async () => {
      // El índice externo es compartido: si el QR de staff o una reparación ya
      // acreditaron esta venta, el POS no debe sumarla otra vez.
      mockStore.set(extPath("V-9"), {
        transactionId: "txn-de-backendcl",
        memberId: "uid-1",
        channel: "STORE",
      });

      const result = await accrueSalePoints({
        memberId: "uid-1",
        ventaId: "V-9",
        puntos: 13,
        descripcion: "Venta POS V-9",
      });

      expect(result.status).toBe("ALREADY_PROCESSED");
      expect(disponible()).toBe(100);
      expect(asientos()).toHaveLength(0);
    });

    it("rechaza al socio inexistente", async () => {
      await expect(
        accrueSalePoints({
          memberId: "uid-fantasma",
          ventaId: "V-2",
          puntos: 10,
          descripcion: "Venta POS V-2",
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "MEMBER_NOT_FOUND" });
    });
  });

  describe("holdSalePoints", () => {
    it("pasa los puntos de disponibles a reservados", async () => {
      const hold = await holdSalePoints({
        memberId: "uid-1",
        ventaId: "V-500",
        puntos: 60,
        descripcion: "Canje POS V-500",
      });

      expect(hold).toMatchObject({
        redemptionId: "pos_V-500",
        puntosCanjeados: 60,
        saldoAnterior: 100,
        puntosActuales: 40,
        alreadyHeld: false,
      });
      expect(disponible()).toBe(40);
      expect(reservado()).toBe(60);
      expect(espejo()).toBe(40);

      expect(asientos()[0]).toMatchObject({
        type: "REDEMPTION_HOLD",
        points: -60,
        balanceBefore: 100,
        balanceAfter: 40,
      });
      expect(mockStore.get(movPath("pos_V-500"))).toMatchObject({
        tipo: "CANJE",
        puntos: -60,
        estado: "HELD",
        saldoNuevo: 40,
      });
    });

    it("valida contra el wallet y no contra el espejo inflado", async () => {
      mockStore.set(USER_PATH, { uid: "uid-1", puntosActuales: 500 });
      setWallet({ availablePoints: 30 });

      await expect(
        holdSalePoints({
          memberId: "uid-1",
          ventaId: "V-502",
          puntos: 100,
          descripcion: "Canje POS V-502",
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_POINTS" });

      expect(disponible()).toBe(30);
    });

    it("rechaza el canje sin tocar el saldo cuando no alcanza", async () => {
      await expect(
        holdSalePoints({
          memberId: "uid-1",
          ventaId: "V-501",
          puntos: 500,
          descripcion: "Canje POS V-501",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INSUFFICIENT_POINTS",
      });

      expect(disponible()).toBe(100);
      expect(espejo()).toBe(100);
      expect(mockStore.has(movPath("pos_V-501"))).toBe(false);
    });

    it("no descuenta dos veces si se reintenta la misma venta", async () => {
      await holdSalePoints({
        memberId: "uid-1",
        ventaId: "V-500",
        puntos: 60,
        descripcion: "Canje POS V-500",
      });
      const segunda = await holdSalePoints({
        memberId: "uid-1",
        ventaId: "V-500",
        puntos: 60,
        descripcion: "Canje POS V-500",
      });

      expect(segunda.alreadyHeld).toBe(true);
      expect(disponible()).toBe(40);
      expect(reservado()).toBe(60);
      expect(asientos()).toHaveLength(1);
    });
  });

  describe("confirmSalePointsHold", () => {
    it("libera la reserva al histórico de canjes sin mover el disponible", async () => {
      const hold = await holdSalePoints({
        memberId: "uid-1",
        ventaId: "V-500",
        puntos: 60,
        descripcion: "Canje POS V-500",
      });

      const confirmed = await confirmSalePointsHold({
        redemptionId: hold.redemptionId,
        memberId: "uid-1",
        ventaId: "V-500",
      });

      expect(confirmed).toMatchObject({
        puntosCanjeados: 60,
        puntosActuales: 40,
        alreadyConfirmed: false,
      });
      expect(disponible()).toBe(40);
      expect(reservado()).toBe(0);
      expect(wallet().lifetimeRedeemedPoints).toBe(60);
      expect(espejo()).toBe(40);
      expect(mockStore.get(movPath("pos_V-500"))).toMatchObject({
        estado: "CONFIRMED",
      });
      expect(asientos()[1]).toMatchObject({
        type: "REDEMPTION_CONFIRM",
        points: -60,
        balanceBefore: 40,
        balanceAfter: 40,
      });
    });

    it("es idempotente", async () => {
      const hold = await holdSalePoints({
        memberId: "uid-1",
        ventaId: "V-500",
        puntos: 60,
        descripcion: "Canje POS V-500",
      });
      await confirmSalePointsHold({
        redemptionId: hold.redemptionId,
        memberId: "uid-1",
        ventaId: "V-500",
      });
      const segunda = await confirmSalePointsHold({
        redemptionId: hold.redemptionId,
        memberId: "uid-1",
        ventaId: "V-500",
      });

      expect(segunda.alreadyConfirmed).toBe(true);
      expect(disponible()).toBe(40);
      expect(reservado()).toBe(0);
      expect(wallet().lifetimeRedeemedPoints).toBe(60);
    });

    it("falla si no hay reserva para esa venta", async () => {
      await expect(
        confirmSalePointsHold({
          redemptionId: "pos_V-inexistente",
          memberId: "uid-1",
          ventaId: "V-inexistente",
        }),
      ).rejects.toMatchObject({ code: "REDEMPTION_NOT_FOUND" });
    });
  });

  describe("cancelSalePointsHold", () => {
    it("reintegra los puntos de una reserva que no se confirmó", async () => {
      const hold = await holdSalePoints({
        memberId: "uid-1",
        ventaId: "V-500",
        puntos: 60,
        descripcion: "Canje POS V-500",
      });
      expect(disponible()).toBe(40);

      await cancelSalePointsHold({
        redemptionId: hold.redemptionId,
        memberId: "uid-1",
        ventaId: "V-500",
      });

      expect(disponible()).toBe(100);
      expect(reservado()).toBe(0);
      expect(espejo()).toBe(100);
      expect(mockStore.get(movPath("pos_V-500"))).toMatchObject({
        estado: "CANCELLED",
      });
      expect(asientos()[1]).toMatchObject({
        type: "REDEMPTION_RELEASE",
        points: 60,
        balanceAfter: 100,
      });
    });

    it("no revierte un canje ya confirmado", async () => {
      const hold = await holdSalePoints({
        memberId: "uid-1",
        ventaId: "V-500",
        puntos: 60,
        descripcion: "Canje POS V-500",
      });
      await confirmSalePointsHold({
        redemptionId: hold.redemptionId,
        memberId: "uid-1",
        ventaId: "V-500",
      });

      await cancelSalePointsHold({
        redemptionId: hold.redemptionId,
        memberId: "uid-1",
        ventaId: "V-500",
      });

      expect(disponible()).toBe(40);
      expect(reservado()).toBe(0);
      expect(mockStore.get(movPath("pos_V-500"))).toMatchObject({
        estado: "CONFIRMED",
      });
    });
  });
});
