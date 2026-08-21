import { ApiError } from "../src/utils/api-error";
import { assertCajaActivaForPosLogin } from "../src/services/auth.service";
import * as sucursalService from "../src/services/sucursal.service";

jest.mock("../src/services/sucursal.service");

const mockedGetCajaById = sucursalService.getCajaById as jest.MockedFunction<
  typeof sucursalService.getCajaById
>;

describe("assertCajaActivaForPosLogin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("no valida caja para ADMIN sin caja asignada", async () => {
    await expect(
      assertCajaActivaForPosLogin({
        id: "u1",
        uid: "u1",
        rol: "CONCESION_ADMIN",
        sucursalId: "s1",
        cajaId: null,
      }),
    ).resolves.toBeUndefined();

    expect(mockedGetCajaById).not.toHaveBeenCalled();
  });

  it("no valida caja para el cajero Cinépolis sin caja asignada", async () => {
    await expect(
      assertCajaActivaForPosLogin({
        id: "cine-1",
        uid: "cine-1",
        email: "cinepoliscl@clubleon.mx",
        rol: "CONCESION_VENDEDOR",
        sucursalId: null,
        cajaId: null,
      }),
    ).resolves.toBeUndefined();

    expect(mockedGetCajaById).not.toHaveBeenCalled();
  });

  it("no valida caja para Cinépolis aunque el perfil no traiga email", async () => {
    await expect(
      assertCajaActivaForPosLogin(
        {
          id: "cine-1",
          uid: "cine-1",
          rol: "CONCESION_VENDEDOR",
          sucursalId: null,
          cajaId: null,
        },
        "cinepoliscl@clubleon.mx",
      ),
    ).resolves.toBeUndefined();

    expect(mockedGetCajaById).not.toHaveBeenCalled();
  });

  it("rechaza login de VENDEDOR sin caja asignada", async () => {
    await expect(
      assertCajaActivaForPosLogin({
        id: "u1",
        uid: "u1",
        rol: "CONCESION_VENDEDOR",
        sucursalId: "YkHdYtYgsQ2QD37Vb6Az",
        cajaId: null,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CAJA_NO_ASIGNADA",
      message: "No tienes una caja asignada. Contacta al administrador.",
    });

    expect(mockedGetCajaById).not.toHaveBeenCalled();
  });

  it("rechaza login de VENDEDOR sin sucursal", async () => {
    await expect(
      assertCajaActivaForPosLogin({
        id: "u1",
        uid: "u1",
        rol: "CONCESION_VENDEDOR",
        sucursalId: null,
        cajaId: "c1",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CAJA_NO_ASIGNADA",
      message: "No tienes una caja asignada. Contacta al administrador.",
    });

    expect(mockedGetCajaById).not.toHaveBeenCalled();
  });

  it("permite login cuando la caja está activa", async () => {
    mockedGetCajaById.mockResolvedValue({
      id: "e5d3q5cJx950Lz4nbnLO",
      nombre: "Caja 3",
      activo: true,
      orden: 0,
    });

    await expect(
      assertCajaActivaForPosLogin({
        id: "u1",
        uid: "u1",
        rol: "CONCESION_VENDEDOR",
        sucursalId: "YkHdYtYgsQ2QD37Vb6Az",
        cajaId: "e5d3q5cJx950Lz4nbnLO",
      }),
    ).resolves.toBeUndefined();

    expect(mockedGetCajaById).toHaveBeenCalledWith(
      "YkHdYtYgsQ2QD37Vb6Az",
      "e5d3q5cJx950Lz4nbnLO",
    );
  });

  it("rechaza login cuando la caja está inactiva", async () => {
    mockedGetCajaById.mockResolvedValue({
      id: "e5d3q5cJx950Lz4nbnLO",
      nombre: "Caja 3",
      activo: false,
      orden: 0,
    });

    await expect(
      assertCajaActivaForPosLogin({
        id: "u1",
        uid: "u1",
        rol: "CONCESION_VENDEDOR",
        sucursalId: "YkHdYtYgsQ2QD37Vb6Az",
        cajaId: "e5d3q5cJx950Lz4nbnLO",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CAJA_INACTIVA",
      message: "Caja inactiva. Contacta al administrador.",
    });
  });

  it("rechaza login cuando la caja no existe", async () => {
    mockedGetCajaById.mockRejectedValue(
      new ApiError(404, "Caja no encontrada", true, "NOT_FOUND"),
    );

    await expect(
      assertCajaActivaForPosLogin({
        id: "u1",
        uid: "u1",
        rol: "CONCESION_VENDEDOR",
        sucursalId: "YkHdYtYgsQ2QD37Vb6Az",
        cajaId: "caja-inexistente",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CAJA_INACTIVA",
      message: "Caja inactiva. Contacta al administrador.",
    });
  });
});
