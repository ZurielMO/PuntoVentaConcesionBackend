declare global {
  namespace Express {
    interface AuthenticatedUser {
      uid: string;
      email?: string;
      rol?: string;
      nombre?: string;
      activo?: boolean;
      admin?: boolean;
      isAdmin?: boolean;
      [key: string]: unknown;
    }

    /** Identidad de la PDA autenticada; solo existe en las rutas `/pda`. */
    interface PdaContext {
      deviceId: string;
      pairingCode: string;
      concesionId?: string;
      sucursalId?: string;
      cajaId?: string;
      cajaNombre?: string;
    }

    interface Request {
      user?: AuthenticatedUser;
      pda?: PdaContext;
      rawBody?: Buffer;
      requestId?: string;
    }
  }
}

export {};
