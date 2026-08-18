import fs from "fs";
import path from "path";

export interface BuildInfo {
  /** SHA del commit desplegado. */
  commit: string | null;
  /** ISO del momento en que CI generó el sello. */
  builtAt: string | null;
}

/**
 * `build-info.json` lo escribe el workflow de deploy junto a `package.json` y
 * viaja en el paquete de la function. No existe en local ni en tests, así que
 * la lectura falla en silencio.
 */
const readBuildInfoFile = (): Partial<BuildInfo> => {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "..", "build-info.json"),
      "utf8",
    );
    return JSON.parse(raw) as Partial<BuildInfo>;
  } catch {
    return {};
  }
};

let cache: BuildInfo | null = null;

export const getBuildInfo = (): BuildInfo => {
  if (!cache) {
    const fromFile = readBuildInfoFile();
    cache = {
      commit: process.env.BUILD_COMMIT_SHA ?? fromFile.commit ?? null,
      builtAt: fromFile.builtAt ?? null,
    };
  }
  return cache;
};
