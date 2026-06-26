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

    interface Request {
      user?: AuthenticatedUser;
      rawBody?: Buffer;
      requestId?: string;
    }
  }
}

export {};
