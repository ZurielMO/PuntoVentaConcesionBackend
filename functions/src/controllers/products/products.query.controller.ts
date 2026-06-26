import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as productService from "../../services/product.service";

export const getProductsByConcession = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await productService.listProductsByConcession(
      req.params.concesionId,
    );
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const getProducts = asyncHandler(
  async (_req: Request, res: Response) => {
    const data = await productService.listProducts();
    res.status(200).json({ success: true, data, count: data.length });
  },
);

export const getProductById = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await productService.getProductById(req.params.id);
    res.status(200).json({ success: true, data });
  },
);
