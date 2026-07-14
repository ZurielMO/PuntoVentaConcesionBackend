import { z } from "zod";

const isValidGregorianDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const expectedBusinessDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidGregorianDate, "expectedBusinessDate debe ser una fecha valida");

const expectedJornadaIdSchema = z.string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}__J\d+$/)
  .refine((value) => isValidGregorianDate(value.slice(0, 10)), "expectedJornadaId contiene una fecha invalida");

export const createCorteSchema = z
  .object({
    fecha: z.string().min(1),
    comentarios: z.string().max(1000).optional(),
    estatus: z.string().min(1),
    totalReal: z.number(),
    totalCaja: z.number(),
    efectivoContado: z.number().nonnegative().optional(),
    diferenciaCaja: z.number().optional(),
  })
  .strict();

export const updateCorteSchema = z
  .object({
    fecha: z.string().min(1).optional(),
    comentarios: z.string().max(1000).optional(),
    estatus: z.string().min(1).optional(),
    totalReal: z.number().optional(),
    totalCaja: z.number().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debes enviar al menos un campo",
  });

export const cerrarCorteSchema = z
  .object({
    comentarios: z.string().max(1000).optional(),
    efectivoContado: z.number().nonnegative().optional(),
    sesionCajaId: z.string().trim().min(1).max(128).optional(),
    expectedJornadaId: expectedJornadaIdSchema.optional(),
    expectedBusinessDate: expectedBusinessDateSchema.optional(),
  })
  .strict();

export type CreateCorteInput = z.infer<typeof createCorteSchema>;
export type UpdateCorteInput = z.infer<typeof updateCorteSchema>;
export type CerrarCorteInput = z.infer<typeof cerrarCorteSchema>;
