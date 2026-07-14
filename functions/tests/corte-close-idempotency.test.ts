import {
  assertCorteContextPreconditions,
  buildLegacyCloseIdentity,
  createCorte,
  paginateCortesRows,
  persistCorteIdempotente,
  selectLegacyCorteRows,
  selectExactClosedCorte,
  type CorteCloseTransactionPort,
  type CorteCloseTransactionRunner,
} from "../src/services/corte.service";
import { selectScopedSnapshot } from "../src/services/corte-reporte.service";
import { cerrarCorteSchema } from "../src/middleware/validators/corte.validator";

const createInMemoryRunner = (conflictingClosed = false) => {
  let stored: Record<string, unknown> | null = null;
  let creates = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const runner: CorteCloseTransactionRunner = <T>(
    work: (transaction: CorteCloseTransactionPort) => Promise<T>,
  ): Promise<T> => {
    const operation = queue.then(() => work({
      get: async () => ({
        exists: stored != null,
        idempotencyKeyHash: (stored?.idempotencyKeyHash as string | null | undefined) ?? null,
        conflictingClosed,
      }),
      create: (payload: Record<string, unknown>) => {
        stored = payload;
        creates += 1;
      },
    })) as Promise<T>;
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  return { runner, getCreates: () => creates };
};

describe("deterministic corte close", () => {
  it("returns the existing close for concurrent retries of the same operation", async () => {
    const memory = createInMemoryRunner();
    const payload = { idempotencyKeyHash: "same-key", estatus: "CERRADO" };
    const [first, retry] = await Promise.all([
      persistCorteIdempotente(memory.runner, payload, "same-key"),
      persistCorteIdempotente(memory.runner, payload, "same-key"),
    ]);
    expect([first, retry].sort()).toEqual([false, true]);
    expect(memory.getCreates()).toBe(1);
  });

  it("rejects a different operation after the deterministic close exists", async () => {
    const memory = createInMemoryRunner();
    await persistCorteIdempotente(memory.runner, { idempotencyKeyHash: "key-a" }, "key-a");
    await expect(
      persistCorteIdempotente(memory.runner, { idempotencyKeyHash: "key-b" }, "key-b"),
    ).rejects.toMatchObject({ statusCode: 409, code: "CORTE_ALREADY_CLOSED" });
    expect(memory.getCreates()).toBe(1);
  });

  it("builds one stable legacy identity for a scope and business date", () => {
    const input = {
      businessDate: "2026-07-13",
      concesionId: "concession-a",
      sucursalId: "branch-a",
      cajaId: "cash-a",
      idUser: "seller-a",
    };
    expect(buildLegacyCloseIdentity(input)).toBe(buildLegacyCloseIdentity(input));
    expect(buildLegacyCloseIdentity({ ...input, sesionCajaId: "session-a" }))
      .toBe(buildLegacyCloseIdentity({ ...input, sesionCajaId: "session-b" }));
    expect(buildLegacyCloseIdentity({ ...input, inventarioId: "inventory-a" }))
      .toBe(buildLegacyCloseIdentity({ ...input, inventarioId: "inventory-b" }));
    expect(() => buildLegacyCloseIdentity({ ...input, cajaId: undefined }))
      .toThrow(expect.objectContaining({ code: "INVALID_CORTE_CLOSE_UNIT" }));
    expect(buildLegacyCloseIdentity(input)).not.toBe(buildLegacyCloseIdentity({ ...input, businessDate: "2026-07-14" }));
  });

  it("blocks legacy random-ID closes in both creation directions", async () => {
    await expect(persistCorteIdempotente(
      createInMemoryRunner(true).runner,
      { idempotencyKeyHash: "key-a" },
      "key-a",
    )).rejects.toMatchObject({ statusCode: 409, code: "CORTE_ALREADY_CLOSED" });

    await expect(createCorte(
      { concesionId: "concession-a", sucursalId: "branch-a", idUser: "seller-a" },
      { fecha: "2026-07-13", estatus: "CERRADO", totalReal: 10, totalCaja: 10 },
    )).rejects.toMatchObject({ statusCode: 409, code: "CORTE_CLOSE_REQUIRES_AUTHORITATIVE_ENDPOINT" });
  });

  it("never substitutes a snapshot from another seller, caja or inventory", () => {
    const wrong = { id: "wrong", estatus: "CERRADO", totalesSnapshot: {}, cajaId: "cash-b", idUser: "seller-b", inventarioId: "inventory-b" };
    const right = { id: "right", estatus: "CERRADO", totalesSnapshot: {}, cajaId: "cash-a", idUser: "seller-a", inventarioId: "inventory-a" };
    const filters = { cajaId: "cash-a", idUser: "seller-a", inventarioId: "inventory-a" };
    expect(selectScopedSnapshot([wrong, right], filters)?.id).toBe("right");
    expect(selectScopedSnapshot([wrong], filters)).toBeUndefined();
  });

  it.each([
    ["cajaId", "cash-a"],
    ["idUser", "seller-a"],
    ["inventarioId", "inventory-a"],
  ] as const)("requires exact scope presence in both directions for %s", (field, value) => {
    const legacyBroad = { id: "legacy", estatus: "CERRADO", totalesSnapshot: {} };
    const scoped = { id: "scoped", estatus: "CERRADO", totalesSnapshot: {}, [field]: value };
    const filters = { [field]: value };

    expect(selectScopedSnapshot([legacyBroad, scoped], filters)?.id).toBe("scoped");
    expect(selectScopedSnapshot([scoped, legacyBroad], {})?.id).toBe("legacy");
    expect(selectScopedSnapshot([legacyBroad], filters)).toBeUndefined();
    expect(selectScopedSnapshot([scoped], {})).toBeUndefined();
  });

  it("uses a closed summary snapshot only for the exact operational scope", () => {
    const broad = { id: "broad", estatus: "CERRADO", concesionId: "concession-a" };
    const seller = { id: "seller", estatus: "CERRADO", concesionId: "concession-a", sucursalId: "branch-a", cajaId: "cash-a", idUser: "seller-a" };
    const inventory = { ...seller, id: "inventory", inventarioId: "inventory-a" };
    const broadFilters = { concesionId: "concession-a" };
    const sellerFilters = { concesionId: "concession-a", sucursalId: "branch-a", cajaId: "cash-a", idUser: "seller-a" };

    expect(selectExactClosedCorte([seller], broadFilters)).toBeUndefined();
    expect(selectExactClosedCorte([seller, broad], broadFilters)?.id).toBe("broad");
    expect(selectExactClosedCorte([broad], sellerFilters)).toBeUndefined();
    expect(selectExactClosedCorte([broad, seller], sellerFilters)?.id).toBe("seller");
    expect(selectExactClosedCorte([seller, inventory], { ...sellerFilters, inventarioId: "inventory-a" })?.id).toBe("inventory");
  });

  it("rejects stale close context preconditions before a jornada rollover close", () => {
    expect(() => assertCorteContextPreconditions(
      { expectedJornadaId: "2026-07-13__J1", expectedBusinessDate: "2026-07-13" },
      { jornadaId: "2026-07-14__J2", businessDate: "2026-07-14" },
    )).toThrow(expect.objectContaining({ statusCode: 409, code: "CORTE_CONTEXT_CHANGED" }));
    expect(() => assertCorteContextPreconditions(
      { expectedJornadaId: "2026-07-14__J2", expectedBusinessDate: "2026-07-14" },
      { jornadaId: "2026-07-14__J2", businessDate: "2026-07-14" },
    )).not.toThrow();
    expect(cerrarCorteSchema.safeParse({
      expectedJornadaId: "2026-07-14__J2",
      expectedBusinessDate: "2026-07-14",
    }).success).toBe(true);
    expect(cerrarCorteSchema.safeParse({ expectedBusinessDate: "14/07/2026" }).success).toBe(false);
    expect(cerrarCorteSchema.safeParse({ expectedBusinessDate: "2026-02-30" }).success).toBe(false);
    expect(cerrarCorteSchema.safeParse({ expectedJornadaId: "2026-02-30__J1" }).success).toBe(false);
  });

  it("paginates history deterministically without losing equal-date rows", () => {
    const rows = ["c", "a", "b"].map((id) => ({ id, fecha: "2026-07-14", estatus: "CERRADO" }));
    rows.push({ id: "older", fecha: "2026-07-13", estatus: "CERRADO" });
    const first = paginateCortesRows(rows, { limit: 2 });
    const second = paginateCortesRows(rows, { limit: 2, cursor: first.nextCursor });

    expect(first.items.map((row) => row.id)).toEqual(["a", "b"]);
    expect(first).toMatchObject({ hasMore: true, limit: 2 });
    expect(second.items.map((row) => row.id)).toEqual(["c", "older"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null, limit: 2 });
    expect(() => paginateCortesRows(rows, { cursor: "not-a-valid-cursor" }))
      .toThrow(expect.objectContaining({ statusCode: 400, code: "INVALID_CORTE_CURSOR" }));
    expect(() => paginateCortesRows(rows, { limit: 201 }))
      .toThrow(expect.objectContaining({ statusCode: 400, code: "INVALID_CORTE_LIMIT" }));
  });

  it("keeps GET /cortes unbounded and raw while history stays paginated and adapted", () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({
      id: `cut-${String(149 - index).padStart(3, "0")}`,
      fecha: "2026-07-14",
      estatus: "CERRADO",
      totalCaja: index,
    }));
    const legacy = selectLegacyCorteRows(rows, {});
    const history = paginateCortesRows(rows);

    expect(legacy).toHaveLength(150);
    expect(legacy[0].id).toBe("cut-149");
    expect(legacy[0]).not.toHaveProperty("resumen");
    expect(history.items).toHaveLength(100);
    expect(history.items[0]).toHaveProperty("resumen");
    expect(history).toMatchObject({ hasMore: true, limit: 100 });
  });
});
