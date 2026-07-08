import axios from "axios";
import jwt from "jsonwebtoken";
import {
  getBackendClBearerToken,
  getBackendClBaseUrl,
  resetBackendClAuthCacheForTests,
} from "../src/services/backendcl-auth.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const TEST_JWT_SECRET = "test-backendcl-secret";

const signTestToken = (expiresInSeconds: number): string =>
  jwt.sign(
    { uid: "emp-1", email: "empleado@test.com", rol: "EMPLEADO" },
    TEST_JWT_SECRET,
    { expiresIn: expiresInSeconds },
  );

describe("backendcl-auth.service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resetBackendClAuthCacheForTests();
    process.env = { ...originalEnv };
    delete process.env.BACKENDCL_BEARER_TOKEN;
    delete process.env.BACKENDCL_AUTH_EMAIL;
    delete process.env.BACKENDCL_AUTH_PASSWORD;
    process.env.BACKENDCL_API_BASE_URL = "https://example.test/api";
  });

  afterAll(() => {
    process.env = originalEnv;
    resetBackendClAuthCacheForTests();
  });

  it("getBackendClBaseUrl elimina slash final", () => {
    process.env.BACKENDCL_API_BASE_URL = "https://example.test/api/";
    expect(getBackendClBaseUrl()).toBe("https://example.test/api");
  });

  it("usa BACKENDCL_BEARER_TOKEN estático sin llamar a BackendCL", async () => {
    process.env.BACKENDCL_BEARER_TOKEN = "static-override-token";

    const token = await getBackendClBearerToken();

    expect(token).toBe("static-override-token");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("hace login en register-or-login y cachea el JWT", async () => {
    const sessionToken = signTestToken(3600);
    process.env.BACKENDCL_AUTH_EMAIL = "empleado@clubleon.test";
    process.env.BACKENDCL_AUTH_PASSWORD = "secret-password";

    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, token: sessionToken },
    } as never);

    const first = await getBackendClBearerToken();
    const second = await getBackendClBearerToken();

    expect(first).toBe(sessionToken);
    expect(second).toBe(sessionToken);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://example.test/api/api/auth/register-or-login",
      {
        email: "empleado@clubleon.test",
        password: "secret-password",
        nombre: "POS Integration",
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("renueva el token con /api/auth/refresh cuando está cerca de expirar", async () => {
    const nearExpiryToken = signTestToken(120);
    const refreshedToken = signTestToken(3600);
    process.env.BACKENDCL_AUTH_EMAIL = "empleado@clubleon.test";
    process.env.BACKENDCL_AUTH_PASSWORD = "secret-password";

    mockedAxios.post
      .mockResolvedValueOnce({
        data: { success: true, token: nearExpiryToken },
      } as never)
      .mockResolvedValueOnce({
        data: { success: true, token: refreshedToken },
      } as never);

    const first = await getBackendClBearerToken();
    const second = await getBackendClBearerToken();

    expect(first).toBe(nearExpiryToken);
    expect(second).toBe(refreshedToken);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      2,
      "https://example.test/api/api/auth/refresh",
      {},
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${nearExpiryToken}`,
        }),
      }),
    );
  });

  it("vuelve a hacer login si el refresh falla", async () => {
    const nearExpiryToken = signTestToken(120);
    const newLoginToken = signTestToken(3600);
    process.env.BACKENDCL_AUTH_EMAIL = "empleado@clubleon.test";
    process.env.BACKENDCL_AUTH_PASSWORD = "secret-password";

    mockedAxios.post
      .mockResolvedValueOnce({
        data: { success: true, token: nearExpiryToken },
      } as never)
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce({
        data: { success: true, bearerToken: newLoginToken },
      } as never);

    await getBackendClBearerToken();
    const token = await getBackendClBearerToken();

    expect(token).toBe(newLoginToken);
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });

  it("lanza LOYALTY_NOT_CONFIGURED si faltan credenciales y no hay token estático", async () => {
    await expect(getBackendClBearerToken()).rejects.toMatchObject({
      statusCode: 503,
      code: "LOYALTY_NOT_CONFIGURED",
    });
  });
});
