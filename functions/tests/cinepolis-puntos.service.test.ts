const mockDocSet = jest.fn();
const mockDocGet = jest.fn();
const mockQueryGet = jest.fn();
const mockStartAfter = jest.fn();
const mockLimit = jest.fn();
const mockOrderBy = jest.fn();
const mockDoc = jest.fn();

jest.mock("../src/config/firebase", () => ({
  firestorePos: {
    collection: jest.fn(() => ({
      doc: mockDoc,
      orderBy: (...args: unknown[]) => mockOrderBy(...args),
    })),
  },
}));

jest.mock("../src/services/loyalty-points.service", () => ({
  getClubMember: jest.fn(),
  assignPointsBySale: jest.fn(),
}));

import { firestorePos } from "../src/config/firebase";
import * as loyaltyPointsService from "../src/services/loyalty-points.service";
import {
  assignCinepolisPoints,
  generateCinepolisFolio,
  listCinepolisAsignaciones,
  normalizeCinepolisComentario,
} from "../src/services/cinepolis-puntos.service";

const mockedGetClubMember =
  loyaltyPointsService.getClubMember as jest.MockedFunction<
    typeof loyaltyPointsService.getClubMember
  >;
const mockedAssignPointsBySale =
  loyaltyPointsService.assignPointsBySale as jest.MockedFunction<
    typeof loyaltyPointsService.assignPointsBySale
  >;

describe("cinepolis-puntos.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocSet.mockResolvedValue(undefined);
    mockDocGet.mockResolvedValue({ exists: true });
    mockQueryGet.mockResolvedValue({ docs: [] });
    mockStartAfter.mockReturnValue({
      get: (...args: unknown[]) => mockQueryGet(...args),
    });
    mockLimit.mockReturnValue({
      get: (...args: unknown[]) => mockQueryGet(...args),
      startAfter: (...args: unknown[]) => mockStartAfter(...args),
    });
    mockOrderBy.mockReturnValue({
      limit: (...args: unknown[]) => mockLimit(...args),
    });
    mockDoc.mockReturnValue({
      id: "asig-1",
      set: (...args: unknown[]) => mockDocSet(...args),
      get: (...args: unknown[]) => mockDocGet(...args),
    });
  });

  it("generateCinepolisFolio cumple el formato de folio BackendCL", () => {
    const folio = generateCinepolisFolio(new Date("2026-08-20T18:15:30.000Z"));
    expect(folio).toMatch(/^CP-20260820181530-[A-F0-9]{4}$/);
    expect(folio).toMatch(/^[A-Za-z0-9][A-Za-z0-9._# -]*$/);
    expect(folio.length).toBeLessThanOrEqual(80);
  });

  it("normalizeCinepolisComentario usa Cinépolis si viene vacío", () => {
    expect(normalizeCinepolisComentario("")).toBe("Cinépolis");
    expect(normalizeCinepolisComentario("  Combo palomitas  ")).toBe(
      "Combo palomitas",
    );
  });

  it("assignCinepolisPoints envía folioVenta, dinero y descripcion a BackendCL", async () => {
    mockedGetClubMember.mockResolvedValue({
      id: "uid-socio",
      nombre: "Ana León",
      email: "ana@example.com",
      puntosActuales: 10,
    });
    mockedAssignPointsBySale.mockResolvedValue({
      memberId: "uid-socio",
      montoVenta: 350.75,
      puntosAsignados: 35,
      puntosActuales: 45,
      descripcion: "Combo palomitas",
      externalResponse: {},
      status: "APPLIED",
      alreadyProcessed: false,
      externalTransactionId: "pos-sale:CP-TEST",
    });

    const result = await assignCinepolisPoints({
      memberId: "uid-socio",
      dinero: 350.75,
      comentario: "Combo palomitas",
      cashierUid: "cine-1",
      cashierEmail: "cinepoliscl@clubleon.mx",
    });

    expect(mockedAssignPointsBySale).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "uid-socio",
        total: 350.75,
        descripcion: "Combo palomitas",
        folioVenta: expect.stringMatching(/^CP-/),
        ventaId: expect.stringMatching(/^CP-/),
      }),
    );
    expect(result.puntosAsignados).toBe(35);
    expect(result.puntosActuales).toBe(45);
    expect(result.folioVenta).toMatch(/^CP-/);
    expect(mockDocSet).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "uid-socio",
        customerFullName: "Ana León",
        amountMxn: 350.75,
        points: 35,
        comentario: "Combo palomitas",
        cashierEmail: "cinepoliscl@clubleon.mx",
      }),
    );
  });

  it("listCinepolisAsignaciones lee cinepolis_asignaciones", async () => {
    mockQueryGet.mockResolvedValue({
      docs: [
        {
          id: "row-1",
          data: () => ({
            memberId: "uid-socio",
            customerFullName: "Ana León",
            amountMxn: 100,
            points: 10,
            puntosActuales: 20,
            comentario: "Cinépolis",
            folioVenta: "CP-1",
            cashierUid: "cine-1",
            cashierEmail: "cinepoliscl@clubleon.mx",
            createdAt: "2026-08-20T18:00:00.000Z",
          }),
        },
      ],
    });

    const result = await listCinepolisAsignaciones({ limit: 20 });

    expect(firestorePos.collection).toHaveBeenCalledWith(
      "cinepolis_asignaciones",
    );
    expect(mockOrderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "row-1",
      customerFullName: "Ana León",
      points: 10,
    });
    expect(result.hasMore).toBe(false);
  });
});
