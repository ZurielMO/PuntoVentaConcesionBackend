import axios from "axios";

const mockMovGet = jest.fn();
const mockMovSet = jest.fn();
const mockUserDocGet = jest.fn();
const mockUserDocSet = jest.fn();
const mockWhereGet = jest.fn();

jest.mock("../src/config/app.firebase", () => ({
  firestoreApp: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: (...args: unknown[]) => mockUserDocGet(...args),
        set: (...args: unknown[]) => mockUserDocSet(...args),
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            get: (...args: unknown[]) => mockMovGet(...args),
            set: (...args: unknown[]) => mockMovSet(...args),
          })),
        })),
      })),
      where: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: (...args: unknown[]) => mockWhereGet(...args),
        })),
      })),
    })),
  },
}));

const mockEnqueuePendingAccrual = jest.fn();
const mockMarkPendingAccrualCompleted = jest.fn();
const mockMarkPendingAccrualFailed = jest.fn();
const mockListPendingAccruals = jest.fn();

jest.mock("../src/services/loyalty-outbox.service", () => ({
  buildPosSaleIdempotencyKey: (ventaId: string) => `pos-sale:${ventaId}`,
  enqueuePendingAccrual: (...args: unknown[]) =>
    mockEnqueuePendingAccrual(...args),
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
  recordPosRedemptionMovement,
  ventaAcumulaPuntos,
} from "../src/services/loyalty-points.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("loyalty-points.service", () => {
  beforeAll(() => {
    process.env.BACKENDCL_API_BASE_URL =
      "https://example.test/api";
    process.env.BACKENDCL_BEARER_TOKEN = "test-jwt-token";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockMovGet.mockResolvedValue({ exists: false });
    mockMovSet.mockResolvedValue(undefined);
    mockUserDocGet.mockResolvedValue({ exists: false, data: () => undefined });
    mockUserDocSet.mockResolvedValue(undefined);
    mockWhereGet.mockResolvedValue({ empty: true, docs: [] });
    mockEnqueuePendingAccrual.mockImplementation(async (params) => ({
      id: `pos_acc_${params.ventaId}`,
      idempotencyKey: `pos-sale:${params.ventaId}`,
      status: "PENDING",
      attempts: 1,
      ...params,
    }));
    mockMarkPendingAccrualCompleted.mockResolvedValue(undefined);
    mockMarkPendingAccrualFailed.mockResolvedValue(undefined);
    mockListPendingAccruals.mockResolvedValue([]);
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockImplementation(
      (payload: unknown) =>
        Boolean(
          payload &&
            typeof payload === "object" &&
            "isAxiosError" in payload &&
            (payload as { isAxiosError?: boolean }).isAxiosError,
        ),
    );
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

  it("getClubMember llama GET /api/usuarios/{id} con Bearer", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          id: "uid-1",
          nombre: "Juan Pérez",
          email: "juan@test.com",
          puntosActuales: 120,
        },
      },
    } as never);

    const member = await getClubMember("uid-1");

    expect(member).toEqual({
      id: "uid-1",
      nombre: "Juan Pérez",
      email: "juan@test.com",
      puntosActuales: 120,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://example.test/api/usuarios/uid-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-jwt-token",
        }),
      }),
    );
  });

  it("getClubMember usa usuariosApp si BackendCL no responde", async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockUserDocGet.mockResolvedValueOnce({
      exists: true,
      id: "uid-1",
      data: () => ({
        uid: "uid-1",
        nombre: "Ana Socio",
        email: "ana@test.com",
        puntosActuales: 80,
      }),
    });

    const member = await getClubMember("uid-1");

    expect(member).toEqual({
      id: "uid-1",
      nombre: "Ana Socio",
      email: "ana@test.com",
      puntosActuales: 80,
    });
  });

  it("assignPointsBySale mapea 403 como permisos insuficientes", async () => {
    mockedAxios.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 403, data: { message: "No tienes permisos" } },
    });

    await expect(
      assignPointsBySale({ memberId: "uid-2", total: 100, ventaId: "V-1" }),
    ).rejects.toMatchObject({
      code: "BACKENDCL_FORBIDDEN",
      message: expect.stringContaining("CONCESION_VENDEDOR"),
    });
  });

  it("createRedemptionHold y confirmRedemptionHold usan el namespace interno", async () => {
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          redemption: { redemptionId: "red-1" },
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          transaction: { balanceAfter: 420 },
        },
      } as never);

    const hold = await createRedemptionHold({
      memberId: "uid-3",
      puntos: 500,
      ventaId: "V-500",
    });
    expect(hold.redemptionId).toBe("red-1");

    const result = await confirmRedemptionHold({
      redemptionId: hold.redemptionId,
      ventaId: "V-500",
      memberId: "uid-3",
      puntosCanjeados: 500,
      descripcion: "Canje POS V-500",
    });

    expect(result.puntosCanjeados).toBe(500);
    expect(result.montoPuntos).toBe(50);
    expect(result.puntosActuales).toBe(420);

    // /api/loyalty/v1 lo intercepta el router de partners y responde 401 a un
    // JWT de sesión: las rutas del POS tienen que ir al namespace interno.
    expect(mockedAxios.post.mock.calls[0][0]).toBe(
      "https://example.test/api/loyalty/internal/v1/redemptions",
    );
    expect(mockedAxios.post.mock.calls[1][0]).toBe(
      "https://example.test/api/loyalty/internal/v1/redemptions/red-1/confirm",
    );
    expect(mockMovSet).toHaveBeenCalledWith(
      expect.objectContaining({
        tipo: "CANJE",
        puntos: -500,
        origen: "pos",
        origenId: "V-500",
        referencia: "V-500",
        descripcion: "Pago en concesión - V-500",
        saldoAnterior: 920,
        saldoNuevo: 420,
      }),
    );
  });

  it("si el namespace interno responde 404 reintenta con /api/loyalty/v1", async () => {
    const notFound = Object.assign(new Error("not found"), {
      isAxiosError: true,
      response: { status: 404, data: {} },
    });
    mockedAxios.post
      .mockRejectedValueOnce(notFound as never)
      .mockResolvedValueOnce({
        data: { redemption: { redemptionId: "red-alt" } },
      } as never);

    const hold = await createRedemptionHold({
      memberId: "uid-9",
      puntos: 100,
      ventaId: "V-ALT",
    });

    expect(hold.redemptionId).toBe("red-alt");
    expect(mockedAxios.post.mock.calls[0][0]).toBe(
      "https://example.test/api/loyalty/internal/v1/redemptions",
    );
    expect(mockedAxios.post.mock.calls[1][0]).toBe(
      "https://example.test/api/loyalty/v1/redemptions",
    );
  });

  it("recordPosRedemptionMovement es idempotente por ventaId", async () => {
    mockMovGet.mockResolvedValueOnce({ exists: true });

    await recordPosRedemptionMovement({
      memberId: "uid-1",
      ventaId: "V-123",
      puntosCanjeados: 500,
      saldoNuevo: 578,
    });

    expect(mockMovSet).not.toHaveBeenCalled();
  });

  it("recordPosRedemptionMovement escribe movimiento_puntos con folio POS", async () => {
    await recordPosRedemptionMovement({
      memberId: "uid-1",
      ventaId: "V-1783376649722",
      puntosCanjeados: 500,
      saldoNuevo: 578,
    });

    expect(mockMovSet).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pos_V-1783376649722",
        usuarioId: "uid-1",
        tipo: "CANJE",
        puntos: -500,
        saldoAnterior: 1078,
        saldoNuevo: 578,
        origen: "pos",
        origenId: "V-1783376649722",
        referencia: "V-1783376649722",
        descripcion: "Pago en concesión - V-1783376649722",
      }),
    );
  });

  it("assignPointsBySale llama asignar-por-venta con dinero y descripcion", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          montoVenta: 320,
          puntosAsignados: 32,
          puntosActuales: 152,
        },
      },
    } as never);

    const result = await assignPointsBySale({
      memberId: "uid-2",
      total: 320,
      ventaId: "V-123",
    });

    expect(result.puntosAsignados).toBe(32);
    expect(result.descripcion).toBe("Venta POS V-123");

    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/usuarios/uid-2/puntos/asignar-por-venta",
    );
    expect(body).toEqual({
      folioVenta: "V-123",
      dinero: 320,
      descripcion: "Venta POS V-123",
      externalTransactionId: "pos-sale:V-123",
    });
    expect(result.status).toBe("APPLIED");
    expect(result.externalTransactionId).toBe("pos-sale:V-123");
  });

  // Caso 2: la misma venta enviada dos veces se acredita una sola vez.
  it("assignPointsBySale reporta ALREADY_PROCESSED sin volver a acreditar", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        alreadyProcessed: true,
        code: "ALREADY_PROCESSED",
        data: {
          montoVenta: 320,
          puntosAsignados: 32,
          puntosActuales: 152,
          alreadyProcessed: true,
        },
      },
    } as never);

    const result = await assignPointsBySale({
      memberId: "uid-2",
      total: 320,
      ventaId: "V-123",
    });

    expect(result.status).toBe("ALREADY_PROCESSED");
    expect(result.alreadyProcessed).toBe(true);
    // El saldo devuelto es el del ledger, no una suma local.
    expect(result.puntosActuales).toBe(152);
    expect(mockUserDocSet).not.toHaveBeenCalled();
  });

  // Caso 3: BackendCL cae durante la venta. La venta termina, queda PENDING y
  // NO se inventa un segundo saldo en usuariosApp.
  it("assignPointsBySale encola PENDING sin tocar el saldo legacy si BackendCL no responde", async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await assignPointsBySale({
      memberId: "uid-2",
      total: 90,
      ventaId: "V-icee-1",
      concesionId: "conc-1",
      sucursalId: "suc-1",
    });

    expect(result).toMatchObject({
      memberId: "uid-2",
      montoVenta: 90,
      puntosAsignados: 9,
      status: "PENDING",
      alreadyProcessed: false,
      externalTransactionId: "pos-sale:V-icee-1",
    });

    expect(mockEnqueuePendingAccrual).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "uid-2",
        ventaId: "V-icee-1",
        puntos: 9,
        total: 90,
        concesionId: "conc-1",
        sucursalId: "suc-1",
      }),
    );

    // Lo esencial del incidente: ni saldo legacy ni movimiento pos_acc_*.
    expect(mockUserDocSet).not.toHaveBeenCalled();
    expect(mockMovSet).not.toHaveBeenCalled();
  });

  it("assignPointsBySale no encola errores de negocio 4xx", async () => {
    mockedAxios.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404, data: { message: "Socio no encontrado" } },
    });

    await expect(
      assignPointsBySale({ memberId: "uid-2", total: 90, ventaId: "V-404" }),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });

    expect(mockEnqueuePendingAccrual).not.toHaveBeenCalled();
  });

  // Caso 4: BackendCL se recupera y el pendiente se integra al ledger.
  it("reprocessPendingAccruals integra el pendiente y lo marca COMPLETED", async () => {
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
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: { montoVenta: 90, puntosAsignados: 9, puntosActuales: 367 },
      },
    } as never);

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

    const [, body] = mockedAxios.post.mock.calls[0];
    expect(body).toMatchObject({
      externalTransactionId: "pos-sale:V-icee-1",
    });
  });

  // Caso 5: reprocesar algo ya migrado acredita 0 puntos adicionales.
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
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        alreadyProcessed: true,
        data: {
          montoVenta: 90,
          puntosAsignados: 9,
          puntosActuales: 367,
          alreadyProcessed: true,
        },
      },
    } as never);

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

  it("reprocessPendingAccruals conserva el pendiente cuando BackendCL sigue caído", async () => {
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
    mockedAxios.post.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const resumen = await reprocessPendingAccruals(10);

    expect(resumen).toMatchObject({ fallidas: 1, completadas: 0 });
    expect(mockMarkPendingAccrualFailed).toHaveBeenCalledWith(
      expect.objectContaining({ ventaId: "V-down", attempts: 3 }),
    );
    expect(mockMarkPendingAccrualCompleted).not.toHaveBeenCalled();
  });
});
