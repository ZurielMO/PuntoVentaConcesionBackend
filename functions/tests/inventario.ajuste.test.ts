jest.mock("../src/config/firebase", () => ({
  firestorePos: {
    collection: jest.fn(),
  },
}));

jest.mock("../src/config/firebase.appoficial2", () => ({
  isAppOficial2Configured: false,
  getRealtimeDbAppOficial2: jest.fn(),
}));

import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../src/config/firebase";
import { ajustarInventarioProducto } from "../src/services/inventario.service";

describe("ajustarInventarioProducto", () => {
  const prodSet = jest.fn();
  const movSet = jest.fn();
  const invGet = jest.fn();
  const prodGet = jest.fn();
  const movDoc = jest.fn(() => ({ set: movSet, id: "mov-1" }));

  const productosCollection = jest.fn(() => ({
    doc: jest.fn(() => ({
      get: prodGet,
      set: prodSet,
    })),
  }));

  const movimientosCollection = jest.fn(() => ({
    doc: movDoc,
  }));

  const invDoc = jest.fn(() => ({
    get: invGet,
    collection: jest.fn((name: string) => {
      if (name === "productos") return productosCollection();
      if (name === "movimientos") return movimientosCollection();
      throw new Error(`Unexpected subcollection ${name}`);
    }),
  }));

  const inventariosCollection = {
    doc: invDoc,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (firestorePos.collection as jest.Mock).mockImplementation((name: string) => {
      if (name === "inventarios") return inventariosCollection;
      throw new Error(`Unexpected collection ${name}`);
    });
  });

  it("aplica entrada y registra movimiento AJUSTE positivo", async () => {
    invGet.mockResolvedValue({
      exists: true,
      data: () => ({ concesion_id: "conc-1" }),
    });
    prodGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          producto_id: "prod-1",
          cantidad_inicial: 10,
          cantidad_final: 8,
        }),
      })
      .mockResolvedValueOnce({
        exists: true,
        id: "prod-1",
        data: () => ({
          producto_id: "prod-1",
          cantidad_inicial: 10,
          cantidad_final: 13,
        }),
      });

    const result = await ajustarInventarioProducto(
      "inv-1",
      "prod-1",
      { direccion: "entrada", cantidad: 5, motivo: "Reposición" },
      { idUser: "user-1" },
    );

    expect(prodSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cantidad_final: 13,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true },
    );
    expect(movSet).toHaveBeenCalledWith(
      expect.objectContaining({
        tipo: "AJUSTE",
        producto_id: "prod-1",
        cantidad: 5,
        cantidad_anterior: 8,
        cantidad_nueva: 13,
        motivo: "Reposición",
        idUser: "user-1",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ cantidad_final: 13 }),
    );
  });

  it("aplica salida y registra movimiento AJUSTE negativo", async () => {
    invGet.mockResolvedValue({
      exists: true,
      data: () => ({ concesion_id: "conc-1" }),
    });
    prodGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          producto_id: "prod-1",
          cantidad_inicial: 10,
          cantidad_final: 8,
        }),
      })
      .mockResolvedValueOnce({
        exists: true,
        id: "prod-1",
        data: () => ({
          producto_id: "prod-1",
          cantidad_inicial: 10,
          cantidad_final: 5,
        }),
      });

    await ajustarInventarioProducto("inv-1", "prod-1", {
      direccion: "salida",
      cantidad: 3,
    });

    expect(prodSet).toHaveBeenCalledWith(
      expect.objectContaining({ cantidad_final: 5 }),
      { merge: true },
    );
    expect(movSet).toHaveBeenCalledWith(
      expect.objectContaining({
        tipo: "AJUSTE",
        cantidad: -3,
        cantidad_anterior: 8,
        cantidad_nueva: 5,
        motivo: null,
      }),
    );
  });

  it("rechaza salida mayor al stock disponible", async () => {
    invGet.mockResolvedValue({
      exists: true,
      data: () => ({ concesion_id: "conc-1" }),
    });
    prodGet.mockResolvedValue({
      exists: true,
      data: () => ({
        producto_id: "prod-1",
        cantidad_inicial: 10,
        cantidad_final: 2,
      }),
    });

    await expect(
      ajustarInventarioProducto("inv-1", "prod-1", {
        direccion: "salida",
        cantidad: 5,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect(prodSet).not.toHaveBeenCalled();
    expect(movSet).not.toHaveBeenCalled();
  });

  it("rechaza producto inexistente en el inventario", async () => {
    invGet.mockResolvedValue({
      exists: true,
      data: () => ({ concesion_id: "conc-1" }),
    });
    prodGet.mockResolvedValue({ exists: false, data: () => undefined });

    await expect(
      ajustarInventarioProducto("inv-1", "prod-missing", {
        direccion: "entrada",
        cantidad: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
