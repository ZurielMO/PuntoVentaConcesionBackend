const mockAccrueSalePoints = jest.fn();
const mockHoldSalePoints = jest.fn();
const mockConfirmSalePointsHold = jest.fn();
const mockCancelSalePointsHold = jest.fn();
const mockResolveUsuarioAppRef = jest.fn();
const mockReadAvailablePoints = jest.fn();

jest.mock("../src/services/loyalty-ledger.service", () => ({
  accrueSalePoints: (...args: unknown[]) => mockAccrueSalePoints(...args),
  holdSalePoints: (...args: unknown[]) => mockHoldSalePoints(...args),
  confirmSalePointsHold: (...args: unknown[]) =>
    mockConfirmSalePointsHold(...args),
  cancelSalePointsHold: (...args: unknown[]) => mockCancelSalePointsHold(...args),
  resolveUsuarioAppRef: (...args: unknown[]) => mockResolveUsuarioAppRef(...args),
  readAvailablePoints: (...args: unknown[]) => mockReadAvailablePoints(...args),
}));

const mockMarkPendingAccrualCompleted = jest.fn();
const mockMarkPendingAccrualFailed = jest.fn();
const mockListPendingAccruals = jest.fn();

jest.mock("../src/services/loyalty-outbox.service", () => ({
  buildPosSaleIdempotencyKey: (ventaId: string) => `pos-sale:${ventaId}`,
  markPendingAccrualCompleted: (...args: unknown[]) =>
    mockMarkPendingAccrualCompleted(...args),
  markPendingAccrualFailed: (...args: unknown[]) =>
    mockMarkPendingAccrualFailed(...args),
  listPendingAccruals: (...args: unknown[]) => mockListPendingAccruals(...args),
}));

import {
  assignPointsBySale,
  reprocessPendingAccruals,
  calcularCanjePuntos,
  calcularMontoDesdePuntos,
  calcularPuntosNecesariosParaTotal,
  calcularPuntosPorVenta,
  confirmRedemptionHold,
  createRedemptionHold,
  getClubMember,
  PUNTOS_POR_PESO_CANJE,
  ventaAcumulaPuntos,
} from "../src/services/loyalty-points.service";
import { ApiError } from "../src/utils/api-error";

describe("loyalty-points.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMarkPendingAccrualCompleted.mockResolvedValue(undefined);
    mockMarkPendingAccrualFailed.mockResolvedValue(undefined);
    mockListPendingAccruals.mockResolvedValue([]);
    mockCancelSalePointsHold.mockResolvedValue(undefined);
  });

  it("calcularPuntosPorVenta redondea al 10%", () => {
    expect(calcularPuntosPorVenta(350.75)).toBe(35);
    expect(calcularPuntosPorVenta(80)).toBe(8);
  });

  it("ventaAcumulaPuntos es false cuando se pagan puntos (incl. mixtos)", () => {
    expect(
      ventaAcumulaPuntos({ metodoPago: "efectivo", puntosUsados: 0 }),
    ).toBe(true);
    expect(
      ventaAcumulaPuntos({ metodoPago: "tarjeta", puntosUsados: 0 }),
    ).toBe(true);
    expect(ventaAcumulaPuntos({ metodoPago: "puntos", puntosUsados: 800 })).toBe(
      false,
    );
    expect(
      ventaAcumulaPuntos({ metodoPago: "puntos+efectivo", puntosUsados: 500 }),
    ).toBe(false);
    expect(
      ventaAcumulaPuntos({ metodoPago: "puntos+tarjeta", puntosUsados: 400 }),
    ).toBe(false);
    expect(ventaAcumulaPuntos({ metodoPago: "efectivo", puntosUsados: 10 })).toBe(
      false,
    );
  });

  it("calcula canje con 10 puntos por peso (pesos enteros)", () => {
    expect(PUNTOS_POR_PESO_CANJE).toBe(10);
    expect(calcularPuntosNecesariosParaTotal(80)).toBe(800);
    expect(calcularPuntosNecesariosParaTotal(90.5)).toBe(900);
    expect(calcularMontoDesdePuntos(500)).toBe(50);
    expect(calcularMontoDesdePuntos(183)).toBe(18);
    expect(
      calcularCanjePuntos({ total: 80, puntosDisponibles: 500 }),
    ).toEqual({
      puntosUsados: 500,
      montoPuntos: 50,
      restante: 30,
    });
    expect(
      calcularCanjePuntos({ total: 80, puntosDisponibles: 900 }),
    ).toEqual({
      puntosUsados: 800,
      montoPuntos: 80,
      restante: 0,
    });
  });

  it("redondea canje hacia pesos enteros (floor): 183 pts → 180 / $18", () => {
    expect(
      calcularCanjePuntos({ total: 90, puntosDisponibles: 183 }),
    ).toEqual({
      puntosUsados: 180,
      montoPuntos: 18,
      restante: 72,
    });
    expect(
      calcularCanjePuntos({
        total: 90,
        puntosDisponibles: 183,
        puntosSolicitados: 183,
      }),
    ).toEqual({
      puntosUsados: 180,
      montoPuntos: 18,
      restante: 72,
    });
    expect(
      calcularCanjePuntos({ total: 18.5, puntosDisponibles: 185 }),
    ).toEqual({
      puntosUsados: 180,
      montoPuntos: 18,
      restante: 0.5,
    });
    expect(
      calcularCanjePuntos({ total: 90, puntosDisponibles: 9 }),
    ).toEqual({
      puntosUsados: 0,
      montoPuntos: 0,
      restante: 90,
    });
  });

  // El perfil sale de usuariosApp, pero el saldo lo dicta el wallet: el campo
  // `puntosActuales` del socio es solo un espejo y puede venir desfasado.
  it("getClubMember toma el perfil de usuariosApp y el saldo del wallet", async () => {
    mockResolveUsuarioAppRef.mockResolvedValueOnce({
      ref: {},
      id: "doc-1",
      data: {
        uid: "uid-1",
        nombre: "Ana Socio",
        email: "ana@test.com",
        puntosActuales: 80,
      },
    });
    mockReadAvailablePoints.mockResolvedValueOnce(8);

    await expect(getClubMember("uid-1")).resolves.toEqual({
      id: "uid-1",
      nombre: "Ana Socio",
      email: "ana@test.com",
      puntosActuales: 8,
    });
  });

  it("getClubMember responde MEMBER_NOT_FOUND si el socio no existe", async () => {
    mockResolveUsuarioAppRef.mockResolvedValueOnce(null);

    await expect(getClubMember("uid-fantasma")).rejects.toMatchObject({
      statusCode: 404,
      code: "MEMBER_NOT_FOUND",
    });
  });

  it("assignPointsBySale acredita el 10% y devuelve el saldo del ledger", async () => {
    mockAccrueSalePoints.mockResolvedValueOnce({
      memberId: "uid-2",
      status: "APPLIED",
      puntosAsignados: 32,
      saldoAnterior: 120,
      puntosActuales: 152,
      movimientoId: "pos_acc_V-123",
    });

    const result = await assignPointsBySale({
      memberId: "uid-2",
      total: 320,
      ventaId: "V-123",
    });

    expect(mockAccrueSalePoints).toHaveBeenCalledWith({
      memberId: "uid-2",
      ventaId: "V-123",
      puntos: 32,
      descripcion: "Venta POS V-123",
      montoVenta: 320,
    });
    expect(result).toMatchObject({
      status: "APPLIED",
      puntosAsignados: 32,
      puntosActuales: 152,
      alreadyProcessed: false,
      externalTransactionId: "pos-sale:V-123",
      descripcion: "Venta POS V-123",
    });
  });

  // La misma venta enviada dos veces se acredita una sola vez.
  it("assignPointsBySale reporta ALREADY_PROCESSED sin volver a acreditar", async () => {
    mockAccrueSalePoints.mockResolvedValueOnce({
      memberId: "uid-2",
      status: "ALREADY_PROCESSED",
      puntosAsignados: 32,
      saldoAnterior: 120,
      puntosActuales: 152,
      movimientoId: "pos_acc_V-123",
    });

    const result = await assignPointsBySale({
      memberId: "uid-2",
      total: 320,
      ventaId: "V-123",
    });

    expect(result.status).toBe("ALREADY_PROCESSED");
    expect(result.alreadyProcessed).toBe(true);
    expect(result.puntosActuales).toBe(152);
  });

  it("assignPointsBySale propaga el socio inexistente", async () => {
    mockAccrueSalePoints.mockRejectedValueOnce(
      new ApiError(404, "Socio no encontrado", true, "MEMBER_NOT_FOUND"),
    );

    await expect(
      assignPointsBySale({ memberId: "uid-2", total: 90, ventaId: "V-404" }),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("createRedemptionHold reserva los puntos en el ledger", async () => {
    mockHoldSalePoints.mockResolvedValueOnce({
      redemptionId: "pos_V-500",
      memberId: "uid-3",
      puntosCanjeados: 500,
      descripcion: "Canje POS V-500",
      saldoAnterior: 920,
      puntosActuales: 420,
      alreadyHeld: false,
    });

    const hold = await createRedemptionHold({
      memberId: "uid-3",
      puntos: 500,
      ventaId: "V-500",
    });

    expect(hold).toEqual({
      redemptionId: "pos_V-500",
      memberId: "uid-3",
      puntosCanjeados: 500,
      descripcion: "Canje POS V-500",
    });
    expect(mockHoldSalePoints).toHaveBeenCalledWith({
      memberId: "uid-3",
      ventaId: "V-500",
      puntos: 500,
      descripcion: "Canje POS V-500",
    });
  });

  it("createRedemptionHold propaga saldo insuficiente como 400", async () => {
    mockHoldSalePoints.mockRejectedValueOnce(
      new ApiError(
        400,
        "Puntos insuficientes: el socio tiene 40 y se requieren 500",
        true,
        "INSUFFICIENT_POINTS",
      ),
    );

    await expect(
      createRedemptionHold({ memberId: "uid-3", puntos: 500, ventaId: "V-501" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INSUFFICIENT_POINTS",
    });
  });

  it("confirmRedemptionHold devuelve el monto y el saldo posterior", async () => {
    mockConfirmSalePointsHold.mockResolvedValueOnce({
      redemptionId: "pos_V-500",
      memberId: "uid-3",
      puntosCanjeados: 500,
      puntosActuales: 420,
      descripcion: "Canje POS V-500",
      alreadyConfirmed: false,
    });

    const result = await confirmRedemptionHold({
      redemptionId: "pos_V-500",
      ventaId: "V-500",
      memberId: "uid-3",
      puntosCanjeados: 500,
      descripcion: "Canje POS V-500",
    });

    expect(result.puntosCanjeados).toBe(500);
    expect(result.montoPuntos).toBe(50);
    expect(result.puntosActuales).toBe(420);
  });

  it("reprocessPendingAccruals acredita el pendiente y lo marca COMPLETED", async () => {
    mockListPendingAccruals.mockResolvedValueOnce([
      {
        id: "pos_acc_V-icee-1",
        idempotencyKey: "pos-sale:V-icee-1",
        memberId: "uid-2",
        ventaId: "V-icee-1",
        folioVenta: "V-icee-1",
        puntos: 9,
        total: 90,
        descripcion: "Venta POS V-icee-1",
        status: "PENDING",
        attempts: 1,
      },
    ]);
    mockAccrueSalePoints.mockResolvedValueOnce({
      memberId: "uid-2",
      status: "APPLIED",
      puntosAsignados: 9,
      saldoAnterior: 358,
      puntosActuales: 367,
      movimientoId: "pos_acc_V-icee-1",
    });

    const resumen = await reprocessPendingAccruals(10);

    expect(resumen).toMatchObject({
      procesadas: 1,
      completadas: 1,
      yaProcesadas: 0,
      fallidas: 0,
    });
    expect(mockMarkPendingAccrualCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ ventaId: "V-icee-1", alreadyProcessed: false }),
    );
  });

  // Reprocesar algo ya acreditado no suma puntos adicionales.
  it("reprocessPendingAccruals cuenta como yaProcesadas lo que ya está en el ledger", async () => {
    mockListPendingAccruals.mockResolvedValueOnce([
      {
        id: "pos_acc_V-dup",
        idempotencyKey: "pos-sale:V-dup",
        memberId: "uid-2",
        ventaId: "V-dup",
        folioVenta: "V-dup",
        puntos: 9,
        total: 90,
        descripcion: "Venta POS V-dup",
        status: "PENDING",
        attempts: 3,
      },
    ]);
    mockAccrueSalePoints.mockResolvedValueOnce({
      memberId: "uid-2",
      status: "ALREADY_PROCESSED",
      puntosAsignados: 9,
      saldoAnterior: 358,
      puntosActuales: 367,
      movimientoId: "pos_acc_V-dup",
    });

    const resumen = await reprocessPendingAccruals(10);

    expect(resumen).toMatchObject({
      procesadas: 1,
      completadas: 0,
      yaProcesadas: 1,
      fallidas: 0,
    });
    expect(mockMarkPendingAccrualCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ ventaId: "V-dup", alreadyProcessed: true }),
    );
  });

  it("reprocessPendingAccruals conserva el pendiente si el ledger falla", async () => {
    mockListPendingAccruals.mockResolvedValueOnce([
      {
        id: "pos_acc_V-down",
        idempotencyKey: "pos-sale:V-down",
        memberId: "uid-2",
        ventaId: "V-down",
        folioVenta: "V-down",
        puntos: 9,
        total: 90,
        descripcion: "Venta POS V-down",
        status: "PENDING",
        attempts: 2,
      },
    ]);
    mockAccrueSalePoints.mockRejectedValueOnce(new Error("UNAVAILABLE"));

    const resumen = await reprocessPendingAccruals(10);

    expect(resumen).toMatchObject({ fallidas: 1, completadas: 0 });
    expect(mockMarkPendingAccrualFailed).toHaveBeenCalledWith(
      expect.objectContaining({ ventaId: "V-down", attempts: 3 }),
    );
    expect(mockMarkPendingAccrualCompleted).not.toHaveBeenCalled();
  });
});
