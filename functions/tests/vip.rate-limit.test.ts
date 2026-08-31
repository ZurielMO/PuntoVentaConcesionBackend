import { Timestamp } from "firebase-admin/firestore";
import { Request, Response } from "express";

type Row = Record<string, any>;
const mockRows = new Map<string, Row>();

const setAtPath = (target: Row, path: string, value: any) => {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
  const key = parts[parts.length - 1];
  const sentinel = value?.constructor?.name;
  if (sentinel === "NumericIncrementTransform" || value?._methodName === "FieldValue.increment") {
    cursor[key] = Number(cursor[key] || 0) + Number(value.operand ?? value._operand ?? 0);
  } else if (sentinel === "ServerTimestampTransform" || value?._methodName === "FieldValue.serverTimestamp") {
    cursor[key] = Timestamp.now();
  } else {
    cursor[key] = value;
  }
};

class MockRef {
  constructor(public path: string) {}
  async get() {
    return { exists: mockRows.has(this.path), data: () => mockRows.get(this.path) };
  }
  async set(data: Row, options?: { merge?: boolean }) {
    const next = options?.merge ? { ...(mockRows.get(this.path) || {}) } : {};
    Object.entries(data).forEach(([key, value]) => setAtPath(next, key, value));
    mockRows.set(this.path, next);
  }
}

const mockDb = {
  collection: jest.fn(() => ({
    doc: (id: string) => new MockRef(`vip_rate_limits/${id}`),
  })),
  runTransaction: jest.fn(async (handler: (tx: any) => Promise<any>) => handler({
    get: (ref: MockRef) => ref.get(),
    set: (ref: MockRef, data: Row, options?: { merge?: boolean }) => ref.set(data, options),
  })),
};

jest.mock("../src/config/firebase", () => ({ firestorePos: mockDb }));

const guestReq = (body?: Record<string, unknown>) => ({
  header: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? "203.0.113.10" : undefined),
  ip: "203.0.113.10",
  socket: { remoteAddress: "203.0.113.10" },
  body,
}) as unknown as Request;

const invoke = (
  middleware: (req: Request, res: Response, next: (err?: unknown) => void) => unknown,
  req: Request = guestReq(),
) => new Promise<void>((resolve, reject) => {
  void middleware(req, {} as Response, (err?: unknown) => {
    if (err) reject(err);
    else resolve();
  });
});

describe("VIP public rate limit", () => {
  const originalIsLocal = process.env.IS_LOCAL;

  beforeEach(() => {
    mockRows.clear();
    jest.clearAllMocks();
    delete process.env.IS_LOCAL;
  });

  afterAll(() => {
    if (originalIsLocal === undefined) delete process.env.IS_LOCAL;
    else process.env.IS_LOCAL = originalIsLocal;
  });

  it("allows traffic under the window and then returns VIP_RATE_LIMITED", async () => {
    const { vipRateLimit } = await import("../src/middleware/vip-rate-limit.middleware");
    const middleware = vipRateLimit("checkout", 2, 60_000);
    await invoke(middleware);
    await invoke(middleware);
    await expect(invoke(middleware)).rejects.toMatchObject({
      statusCode: 429,
      code: "VIP_RATE_LIMITED",
    });
  });

  it("skips limiting while IS_LOCAL is true", async () => {
    process.env.IS_LOCAL = "true";
    const { vipRateLimit } = await import("../src/middleware/vip-rate-limit.middleware");
    const middleware = vipRateLimit("checkout", 1, 60_000);
    await invoke(middleware);
    await invoke(middleware);
    await invoke(middleware);
  });

  it("isolates confirm retries by Stripe session id", async () => {
    const { vipRateLimit } = await import("../src/middleware/vip-rate-limit.middleware");
    const middleware = vipRateLimit(
      "checkout_confirm",
      1,
      60_000,
      (req) => {
        const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
        return sessionId ? `session:${sessionId}` : undefined;
      },
    );
    await invoke(middleware, guestReq({ sessionId: "cs_a" }));
    await expect(invoke(middleware, guestReq({ sessionId: "cs_a" }))).rejects.toMatchObject({
      statusCode: 429,
      code: "VIP_RATE_LIMITED",
    });
    await invoke(middleware, guestReq({ sessionId: "cs_b" }));
  });
});
