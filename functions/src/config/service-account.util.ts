import * as fs from "fs";
import * as path from "path";
import * as admin from "firebase-admin";

/** Directorios donde buscar archivos de service account en local. */
const getSearchRoots = (fromDir: string): string[] =>
  [
    path.join(fromDir, "../../.."),
    path.join(fromDir, "../.."),
    path.join(fromDir, "../../../.."),
  ].filter((dir, index, arr) => arr.indexOf(dir) === index);

const DEFAULT_FILENAMES = [
  "serviceAccountKey.json",
  "serviceAccountPos.json",
  "acreditaciones.serviceAccountKey.json",
];

/**
 * Busca un service account JSON por:
 *  1. Ruta explícita (env o argumento)
 *  2. Nombres por defecto (serviceAccountKey.json, etc.)
 *  3. Archivos descargados de Firebase (*-firebase-adminsdk-*.json)
 *     filtrados por projectId si se proporciona.
 */
export const resolveServiceAccountPath = (options: {
  fromDir: string;
  explicitPath?: string;
  projectId?: string;
  extraFilenames?: string[];
}): string | null => {
  const candidates: string[] = [];

  if (options.explicitPath?.trim()) {
    candidates.push(options.explicitPath.trim());
  }

  for (const root of getSearchRoots(options.fromDir)) {
    for (const name of [
      ...DEFAULT_FILENAMES,
      ...(options.extraFilenames ?? []),
    ]) {
      candidates.push(path.join(root, name));
    }

    if (fs.existsSync(root)) {
      const adminSdkFiles = fs
        .readdirSync(root)
        .filter(
          (file) =>
            file.endsWith(".json") && file.includes("firebase-adminsdk"),
        );

      for (const file of adminSdkFiles) {
        candidates.push(path.join(root, file));
      }
    }
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    if (options.projectId) {
      try {
        const parsed = require(candidate) as {
          project_id?: string;
          projectId?: string;
        };
        const fileProjectId = parsed.project_id ?? parsed.projectId;
        if (fileProjectId !== options.projectId) {
          continue;
        }
      } catch {
        continue;
      }
    }

    return candidate;
  }

  return null;
};

export const loadServiceAccountFromFile = (
  filePath: string,
): admin.ServiceAccount => require(filePath) as admin.ServiceAccount;
