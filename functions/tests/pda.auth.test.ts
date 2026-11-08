import jwt from "jsonwebtoken";
import request from "supertest";

process.env.JWT_SECRET = "test-jwt-secret-de-usuarios";
process.env.PDA_JWT_SECRET = "test-jwt-secret-de-pdas";
// El limitador de frecuencia escribe en Firestore; aquí no hay base de datos.
process.env.IS_LOCAL = "true";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require("../src/app").default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyPdaToken } = require("../src/services/pda.service");

const pdaToken = (claims: Record<string, unknown> = {}, secret?: string) =>
  jwt.sign({ typ: "pda", ...claims }, secret ?? process.env.PDA_JWT_SECRET!, {
    subject: "device-1",
    audience: "pos-pda",
    issuer: "puntoventa-pda",
    expiresIn: 600,
  });

const userToken = () =>
  jwt.sign(
    { uid: "u1", email: "a@b.c", rol: "CONCESION_SUPERADMIN" },
    process.env.JWT_SECRET!,
    { expiresIn: 600 },
  );

describe("separación entre credenciales de usuario y de PDA", () => {
  it.each([
    "/concessions",
    "/users",
    "/sucursales",
    "/inventarios",
    "/products",
    "/cortes",
    "/detalle-venta",
    "/auth/me",
    "/pda/admin/devices",
  ])("una credencial de PDA no entra a %s", async (path) => {
    const res = await request(app)
      .get(path)
      .set("Authorization", `Bearer ${pdaToken({ cajaId: "c1" })}`);
    expect([401, 503]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it("un JWT de usuario no entra a las rutas PDA", async () => {
    const res = await request(app)
      .get("/pda/concesiones")
      .set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("PDA_TOKEN_INVALID");
  });

  it.each(["/pda/concesiones", "/pda/products", "/pda/detalle-venta"])(
    "%s exige credencial",
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("PDA_UNAUTHENTICATED");
    },
  );

  it("la ruta administrativa de PDAs exige login de usuario", async () => {
    const res = await request(app).get("/pda/admin/devices");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("registrar exige un secreto con entropía suficiente", async () => {
    const res = await request(app)
      .post("/pda/devices/register")
      .send({ deviceId: "device-0123456789abcdef", deviceSecret: "corto" });
    expect(res.status).toBe(400);
  });
});

describe("verifyPdaToken", () => {
  it("acepta un token propio", () => {
    expect(verifyPdaToken(pdaToken({ cajaId: "c1" })).cajaId).toBe("c1");
  });

  it("rechaza otra firma, otra audiencia y otro tipo", () => {
    expect(() => verifyPdaToken(pdaToken({}, "otro"))).toThrow();
    expect(() =>
      verifyPdaToken(
        jwt.sign({ typ: "pda" }, process.env.PDA_JWT_SECRET!, {
          subject: "d",
          audience: "otra",
          issuer: "puntoventa-pda",
        }),
      ),
    ).toThrow();
    expect(() =>
      verifyPdaToken(
        jwt.sign({ typ: "user" }, process.env.PDA_JWT_SECRET!, {
          subject: "d",
          audience: "pos-pda",
          issuer: "puntoventa-pda",
        }),
      ),
    ).toThrow();
  });

  it("no funciona si comparte secreto con los usuarios", () => {
    const original = process.env.PDA_JWT_SECRET;
    process.env.PDA_JWT_SECRET = process.env.JWT_SECRET;
    try {
      expect(() => verifyPdaToken(pdaToken())).toThrow(/no está configurado/);
    } finally {
      process.env.PDA_JWT_SECRET = original;
    }
  });
});
