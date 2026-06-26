import { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

const REQUEST_ID_HEADER = "x-request-id";

export const requestContextMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const incomingRequestId = req.header(REQUEST_ID_HEADER)?.trim();
  const requestId =
    incomingRequestId && incomingRequestId.length > 0
      ? incomingRequestId
      : uuidv4();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
};

export default requestContextMiddleware;
