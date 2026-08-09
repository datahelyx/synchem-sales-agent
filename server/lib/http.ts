import type { NextFunction, Request, Response } from 'express';
import type { z, ZodTypeAny } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

export function asyncRoute(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/**
 * Returns the schema's *output* type, so `.default(...)` fields arrive as
 * required rather than possibly-undefined at every call site.
 */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, 'Some fields need fixing', result.error.flatten().fieldErrors);
  }
  return result.data;
}

export function intParam(value: unknown, name = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, detail: err.detail });
    return;
  }
  console.error(err);
  const message = err instanceof Error ? err.message : 'Something went wrong';
  res.status(500).json({ error: message });
}
