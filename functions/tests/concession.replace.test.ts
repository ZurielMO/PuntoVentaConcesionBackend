jest.mock("../src/config/firebase", () => ({
  firestorePos: {
    collection: jest.fn(),
  },
}));

jest.mock("../src/services/storage.service", () => ({
  normalizeRecordImageUrls: (record: Record<string, unknown> & { id: string }) =>
    record,
}));

import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../src/config/firebase";
import { replaceConcession } from "../src/services/concession.service";

describe("replaceConcession", () => {
  const set = jest.fn();
  const get = jest.fn();
  const doc = jest.fn(() => ({ get, set }));
  const collection = firestorePos.collection as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    collection.mockReturnValue({ doc });
  });

  it("preserva imagenes existentes cuando el payload las omite", async () => {
    const existing = {
      nombre: "Vieja",
      activo: false,
      imagenes: ["https://cdn.example/logo.png"],
      idUser: "user-1",
      createdAt: { seconds: 1 },
    };

    get
      .mockResolvedValueOnce({
        exists: true,
        id: "c1",
        data: () => existing,
      })
      .mockResolvedValueOnce({
        exists: true,
        id: "c1",
        data: () => ({
          ...existing,
          nombre: "Nueva",
          activo: true,
        }),
      });

    await replaceConcession("c1", { nombre: "Nueva", activo: true });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        nombre: "Nueva",
        activo: true,
        imagenes: ["https://cdn.example/logo.png"],
        idUser: "user-1",
        createdAt: existing.createdAt,
        updatedAt: FieldValue.serverTimestamp(),
      }),
    );
  });

  it("permite limpiar imagenes con [] explícito", async () => {
    get
      .mockResolvedValueOnce({
        exists: true,
        id: "c1",
        data: () => ({
          nombre: "Demo",
          activo: true,
          imagenes: ["https://cdn.example/logo.png"],
          idUser: null,
          createdAt: { seconds: 1 },
        }),
      })
      .mockResolvedValueOnce({
        exists: true,
        id: "c1",
        data: () => ({
          nombre: "Demo",
          activo: true,
          imagenes: [],
          idUser: null,
          createdAt: { seconds: 1 },
        }),
      });

    await replaceConcession("c1", {
      nombre: "Demo",
      activo: true,
      imagenes: [],
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        imagenes: [],
      }),
    );
  });
});
