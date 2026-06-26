import { Request, Response } from "express";
import { asyncHandler } from "../../utils/error-handler";
import * as productService from "../../services/product.service";

export const createProduct = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await productService.createProduct(
      req.params.concesionId,
      req.body,
    );
    res.status(201).json({ success: true, data, message: "Producto creado" });
  },
);

export const updateProduct = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await productService.updateProduct(req.params.id, req.body);
    res
      .status(200)
      .json({ success: true, data, message: "Producto actualizado" });
  },
);

export const deleteProduct = asyncHandler(
  async (req: Request, res: Response) => {
    await productService.softDeleteProduct(req.params.id);
    res.status(204).send();
  },
);
