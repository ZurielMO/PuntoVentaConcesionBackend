import type { Request } from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-de-usuarios";
process.env.FIREBASE_API_KEY = "test-api-key";

type Profile = Record<string, unknown>;
const mockProfiles = new Map<string, Profile>();
const mockSetClaims = jest.fn(async () => undefined);
const mockPost = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => mockPost(...args) },
}));

jest.mock("../src/config/app.firebase", () => {
  const emptyQuery = {
    where: () => emptyQuery,
    limit: () => emptyQuery,
    get: async () => ({ empty: true, docs: [] }),
  };
  return {
    USUARIOS_APP_COLLECTION: "usuariosApp",
    hasAppOficialCredentials: true,
    authAppOficial: { setCustomUserClaims: mockSetClaims },
    firestoreApp: {
      collection: () => ({
        ...emptyQuery,
        doc: (id: string) => ({
          get: async () => ({
            id,
            exists: mockProfiles.has(id),
            data: () => mockProfiles.get(id),
          }),
        }),
      }),
    },
  };
});

jest.mock("../src/config/firebase", () => {
  const emptyQuery = {
    where: () => emptyQuery,
    limit: () => emptyQuery,
    get: async () => ({ empty: true, docs: [] }),
  };
  return {
    hasAdminCredentials: true,
    firestorePos: {
      collection: () => ({
        ...emptyQuery,
        doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
      }),
    },
  };
});

jest.mock("../src/services/concession.service", () => ({
  getConcessionNombre: async () => "Concesión de prueba",
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require("../src/services/auth.service");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getOperationalListFilters } = require("../src/utils/list-filters.util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const validators = require("../src/middleware/validators/detalle-venta.validator");

const perfil = (uid: string, extra: Profile = {}): Profile => ({
  uid,
  email: `${uid}@prueba.invalid`,
  nombre: uid,
  activo: true,
  from_concesion: true,
  cajaId: null,
  ...extra,
});

const roles: [string, Profile][] = [
  ["CONCESION_SUPERADMIN", {}],
  ["CONCESION_ADMIN", { concesionId: "c1" }],
  ["CONCESION_ADMIN_CERVECERIA", { concesionId: "c1", sucursalId: "s1" }],
  ["CONCESION_VENDEDOR", { concesionId: "c1", sucursalId: "s1" }],
];

beforeEach(() => {
  mockProfiles.clear();
  mockSetClaims.mockClear();
  mockPost.mockReset();
});

describe("login y sesión sin caja asignada", () => {
  it.each(roles)("%s inicia sesión sin caja", async (rol, extra) => {
    mockProfiles.set("u1", perfil("u1", { rol, ...extra }));
    mockPost.mockResolvedValue({
      data: { localId: "u1", email: "u1@prueba.invalid" },
    });

    const result = await auth.loginWithPassword("u1@prueba.invalid", "secreto");

    expect(typeof result.token).toBe("string");
    expect(result.usuario.uid).toBe("u1");
    // El panel sigue recibiendo el campo: su contrato no cambia.
    expect(result.usuario.cajaId).toBeNull();
    expect(jwt.decode(result.token)).toMatchObject({ uid: "u1", rol, admin: false });
  });

  it.each(roles)("%s conserva su sesión sin caja", async (rol, extra) => {
    mockProfiles.set("u1", perfil("u1", { rol, ...extra }));
    const token = auth.signPosJwt(perfil("u1", { rol }));

    await expect(auth.resolveSessionFromToken(token)).resolves.toMatchObject({
      uid: "u1",
      cajaId: null,
    });
  });

  it("una caja desactivada en el perfil tampoco bloquea", async () => {
    mockProfiles.set(
      "u1",
      perfil("u1", {
        rol: "CONCESION_VENDEDOR",
        sucursalId: "s1",
        cajaId: "caja-que-ya-no-existe",
      }),
    );
    const token = auth.signPosJwt(perfil("u1", { rol: "CONCESION_VENDEDOR" }));

    await expect(auth.resolveSessionFromToken(token)).resolves.toMatchObject({
      uid: "u1",
    });
  });
});

describe("el resto de la autorización sigue igual", () => {
  it("contraseña incorrecta sigue siendo 401", async () => {
    mockPost.mockRejectedValue(new Error("INVALID_PASSWORD"));

    await expect(
      auth.loginWithPassword("u1@prueba.invalid", "mala"),
    ).rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  });

  it("un JWT inválido sigue rechazándose", async () => {
    await expect(auth.resolveSessionFromToken("x")).rejects.toMatchObject({
      statusCode: 401,
      code: "INVALID_TOKEN",
    });
  });

  it("un JWT firmado con otra clave sigue rechazándose", async () => {
    mockProfiles.set("u1", perfil("u1", { rol: "CONCESION_ADMIN" }));
    const forged = jwt.sign({ uid: "u1", rol: "CONCESION_ADMIN" }, "otra-clave");

    await expect(auth.resolveSessionFromToken(forged)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("un usuario desactivado sigue sin entrar", async () => {
    mockProfiles.set(
      "u1",
      perfil("u1", { rol: "CONCESION_VENDEDOR", activo: false }),
    );
    const token = auth.signPosJwt(perfil("u1", { rol: "CONCESION_VENDEDOR" }));

    await expect(auth.resolveSessionFromToken(token)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("un cliente de la app oficial sigue sin acceso al POS", async () => {
    mockProfiles.set(
      "u1",
      perfil("u1", { rol: "CLIENTE", from_concesion: false }),
    );
    const token = auth.signPosJwt(perfil("u1", { rol: "CLIENTE" }));

    await expect(auth.resolveSessionFromToken(token)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe("filtros del vendedor", () => {
  const request = (query: Record<string, string>, user: Profile) =>
    ({ query, user }) as unknown as Request;
  const vendedor = {
    uid: "v1",
    rol: "VENDEDOR",
    concesionId: "c1",
    sucursalId: "s1",
    cajaId: "caja-del-perfil",
  };

  it("no toma la caja del perfil", () => {
    const filters = getOperationalListFilters(request({}, vendedor));

    expect(filters.cajaId).toBeUndefined();
  });

  it("sin caja indicada solo ve sus propias operaciones", () => {
    expect(getOperationalListFilters(request({}, vendedor))).toMatchObject({
      concesionId: "c1",
      sucursalId: "s1",
      idUser: "v1",
    });
  });

  it("con caja indicada sigue limitado a su concesión y sucursal", () => {
    const filters = getOperationalListFilters(
      request({ cajaId: "k1", sucursalId: "otra", concesionId: "otra" }, vendedor),
    );

    expect(filters).toMatchObject({
      concesionId: "c1",
      sucursalId: "s1",
      cajaId: "k1",
    });
    expect(filters.idUser).toBeUndefined();
  });

  it("un admin sigue limitado a su concesión", () => {
    const filters = getOperationalListFilters(
      request(
        { concesionId: "otra", sucursalId: "s9" },
        { uid: "a1", rol: "ADMIN", concesionId: "c1" },
      ),
    );

    expect(filters.concesionId).toBe("c1");
  });
});

describe("cuerpo de la venta", () => {
  const venta = { productos: [{ producto: "p1", cantidad: 1 }] };

  it("con sesión de usuario acepta caja, y sigue sin ser obligatoria en el esquema", () => {
    expect(
      validators.createDetalleVentaSchema.safeParse({ ...venta, cajaId: "k1" }).success,
    ).toBe(true);
    expect(validators.createDetalleVentaSchema.safeParse(venta).success).toBe(true);
  });

  it("la PDA no puede elegir caja por el cuerpo", () => {
    expect(
      validators.createPdaVentaSchema.safeParse({ ...venta, cajaId: "k1" }).success,
    ).toBe(false);
    expect(validators.createPdaVentaSchema.safeParse(venta).success).toBe(true);
  });

  it("rechaza un identificador con ruta", () => {
    expect(
      validators.createDetalleVentaSchema.safeParse({ ...venta, cajaId: "a/b" }).success,
    ).toBe(false);
  });

  it.each(["createDetalleVentaSchema", "createPdaVentaSchema"])(
    "%s sigue exigiendo socio para pagar con puntos",
    (schema) => {
      expect(
        validators[schema].safeParse({ ...venta, metodoPago: "puntos" }).success,
      ).toBe(false);
    },
  );
});
