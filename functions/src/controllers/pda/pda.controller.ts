import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as pdaService from "../../services/pda.service";

export const registerDevice = asyncHandler(async (req: Request, res: Response) => {
  const data = await pdaService.registerDevice(req.body);
  res.status(200).json({ success: true, data });
});

export const createSession = asyncHandler(async (req: Request, res: Response) => {
  const data = await pdaService.createDeviceSession(req.body);
  res.status(200).json({ success: true, data });
});

export const getConcesiones = asyncHandler(async (_req: Request, res: Response) => {
  const data = await pdaService.listPdaConcesiones();
  res.status(200).json({ success: true, data, count: data.length });
});

export const getSucursales = asyncHandler(async (req: Request, res: Response) => {
  const data = await pdaService.listPdaSucursales(req.params.concesionId);
  res.status(200).json({ success: true, data, count: data.length });
});

export const getCajas = asyncHandler(async (req: Request, res: Response) => {
  const data = await pdaService.listPdaCajas(req.params.sucursalId);
  res.status(200).json({ success: true, data, count: data.length });
});

export const createCajaSession = asyncHandler(async (req: Request, res: Response) => {
  const data = await pdaService.createCajaSession(req.pda!.deviceId, req.body);
  res.status(200).json({ success: true, data });
});

export const listDevices = asyncHandler(async (_req: Request, res: Response) => {
  const data = await pdaService.listDevices();
  res.status(200).json({ success: true, data, count: data.length });
});

export const approveDevice = asyncHandler(async (req: Request, res: Response) => {
  const data = await pdaService.approveDevice(req.params.deviceId, req.body.pairingCode);
  res.status(200).json({ success: true, data, message: "Dispositivo autorizado" });
});

export const revokeDevice = asyncHandler(async (req: Request, res: Response) => {
  const data = await pdaService.revokeDevice(req.params.deviceId);
  res.status(200).json({ success: true, data, message: "Dispositivo revocado" });
});
