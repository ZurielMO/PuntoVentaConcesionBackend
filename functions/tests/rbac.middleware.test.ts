jest.mock("../src/config/firebase", () => ({
  firestorePos: {
    collection: jest.fn(),
  },
}));

import { firestorePos } from "../src/config/firebase";
import {
  requireSuperAdmin,
  requireAdminOrSuperAdmin,
  requireInventarioWriteAccess,
  requireInventarioReadAccess,
} from "../src/utils/roles.middlewares";
import { ApiError } from "../src/utils/api-error";

const mockRes = () => ({}) as any;
const mockNext = jest.fn();

const superAdminUser = {
  uid: "sa-1",
  rol: "SUPERADMIN",
  activo: true,
};

const adminUser = {
  uid: "admin-1",
  rol: "ADMIN",
  activo: true,
  concesionId: "conc-1",
};

const vendedorUser = {
  uid: "vend-1",
  rol: "VENDEDOR",
  activo: true,
  concesionId: "conc-1",
  sucursalId: "suc-1",
};

describe("RBAC middleware", () => {
  beforeEach(() => {
    mockNext.mockClear();
    (firestorePos.collection as jest.Mock).mockReset();
  });

  it("requireSuperAdmin permite SUPERADMIN", () => {
    requireSuperAdmin({ user: superAdminUser } as any, mockRes(), mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("requireSuperAdmin bloquea ADMIN", () => {
    expect(() =>
      requireSuperAdmin({ user: adminUser } as any, mockRes(), mockNext),
    ).toThrow(ApiError);
  });

  it("requireAdminOrSuperAdmin permite ADMIN", () => {
    requireAdminOrSuperAdmin({ user: adminUser } as any, mockRes(), mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("requireInventarioWriteAccess bloquea VENDEDOR", async () => {
    const req = {
      user: vendedorUser,
      params: { id: "inv-1" },
    } as any;

    requireInventarioWriteAccess(req, mockRes(), mockNext);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockNext).toHaveBeenCalled();
    const err = mockNext.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(403);
  });

  it("requireInventarioReadAccess permite vendedor de la misma concesión (sin filtro sucursal)", async () => {
    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ concesion_id: "conc-1" }),
    });
    (firestorePos.collection as jest.Mock).mockReturnValue({
      doc: jest.fn().mockReturnValue({ get: mockGet }),
    });

    const req = {
      user: vendedorUser,
      params: { id: "2026-07-17__J1__conc-1" },
    } as any;

    requireInventarioReadAccess(req, mockRes(), mockNext);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockNext).toHaveBeenCalled();
    expect(mockNext.mock.calls[0][0]).toBeUndefined();
  });
});
