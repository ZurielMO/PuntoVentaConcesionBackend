import dotenv from "dotenv";
import path from "path";

let envLoaded = false;

export const loadEnvironment = (): void => {
  if (envLoaded) {
    return;
  }

  // En Cloud Functions las variables se inyectan por el entorno / Secret Manager.
  if (process.env.FUNCTION_NAME || process.env.K_SERVICE) {
    envLoaded = true;
    return;
  }

  dotenv.config({
    path: path.resolve(__dirname, "../../.env"),
  });
  dotenv.config({
    path: path.resolve(__dirname, "../../.env.local"),
    override: true,
  });
  dotenv.config({
    path: path.resolve(__dirname, "../../.secret.local"),
    override: true,
  });

  envLoaded = true;
};

loadEnvironment();
