import {
  validateImageFile,
  storagePathFromUrl,
  buildFirebasePublicUrl,
  normalizeFirebaseImageUrl,
  MAX_IMAGE_BYTES,
} from "../src/services/storage.service";
import { ApiError } from "../src/utils/api-error";

describe("storage.service", () => {
  it("validateImageFile acepta JPEG válido", () => {
    expect(() =>
      validateImageFile({ mimetype: "image/jpeg", size: 1024 }),
    ).not.toThrow();
  });

  it("validateImageFile rechaza MIME inválido", () => {
    expect(() =>
      validateImageFile({ mimetype: "application/pdf", size: 1024 }),
    ).toThrow(ApiError);
  });

  it("validateImageFile rechaza archivo mayor a 5 MB", () => {
    expect(() =>
      validateImageFile({ mimetype: "image/png", size: MAX_IMAGE_BYTES + 1 }),
    ).toThrow(ApiError);
  });

  it("storagePathFromUrl extrae path de URL Firebase", () => {
    const url =
      "https://firebasestorage.googleapis.com/v0/b/bucket/o/products%2Fc1%2Fp1%2Fabc.jpg?alt=media&token=x";
    expect(storagePathFromUrl(url)).toBe("products/c1/p1/abc.jpg");
  });

  it("buildFirebasePublicUrl genera URL sin token", () => {
    const url = buildFirebasePublicUrl(
      "puntoventacl.firebasestorage.app",
      "products/c1/p1/abc.jpg",
    );
    expect(url).toBe(
      "https://firebasestorage.googleapis.com/v0/b/puntoventacl.firebasestorage.app/o/products%2Fc1%2Fp1%2Fabc.jpg?alt=media",
    );
    expect(url).not.toContain("token=");
  });

  it("normalizeFirebaseImageUrl quita token de URLs viejas", () => {
    const old =
      "https://firebasestorage.googleapis.com/v0/b/bucket/o/products%2Fa.jpg?alt=media&token=bad";
    const normalized = normalizeFirebaseImageUrl(old);
    expect(normalized).not.toContain("token=");
    expect(normalized).toContain("?alt=media");
  });
});
