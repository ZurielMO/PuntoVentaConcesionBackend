import axios from "axios";
import { assignConcessionPoints } from "../src/services/concession.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("assignConcessionPoints", () => {
  beforeAll(() => {
    process.env.CONCESSION_POINTS_ASSIGN_URL =
      "https://example.test/api/usuarios";
    process.env.CONCESSION_POINTS_SOURCE_SYSTEM = "backendcl";
    process.env.CONCESSION_POINTS_SOURCE_SECRET = "test-secret";
  });

  it("asigna el 10% de puntos (entero exacto) y llama al backend externo", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } } as never);

    const result = await assignConcessionPoints({
      userId: "user-1",
      total: 250,
      descripcion: "Compra jornada 7",
    });

    expect(result.puntosAsignados).toBe(25);
    expect(result.usuarioId).toBe("user-1");
    expect(typeof result.idOrigen).toBe("string");
    expect(result.idOrigen).toContain(".");

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe("https://example.test/api/usuarios/user-1/puntos/asignar");
    expect(body).toMatchObject({ points: 25, descripcion: "Compra jornada 7" });
  });

  it("redondea hacia arriba cuando el 10% no es entero (Math.ceil)", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} } as never);

    const result = await assignConcessionPoints({
      userId: "user-2",
      total: 99,
      descripcion: "Compra",
    });

    expect(result.puntosAsignados).toBe(10); // 9.9 -> ceil -> 10
  });

  it("reintenta solo con {points} si el externo responde 400", async () => {
    const error400 = {
      isAxiosError: true,
      response: { status: 400 },
    };
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
    mockedAxios.post
      .mockRejectedValueOnce(error400 as never)
      .mockResolvedValueOnce({ data: { retried: true } } as never);

    const result = await assignConcessionPoints({
      userId: "user-3",
      total: 100,
      descripcion: "Compra",
    });

    expect(result.puntosAsignados).toBe(10);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    const secondCallBody = mockedAxios.post.mock.calls[1][1];
    expect(secondCallBody).toEqual({ points: 10 });
  });
});
