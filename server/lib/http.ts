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

/**
 * Turns anything thrown in a route into a JSON response.
 *
 * Database driver errors are translated rather than forwarded: a unique-index
 * violation is a 409 the user can act on, and echoing
 * "SQLITE_CONSTRAINT: UNIQUE constraint failed: product.sku" back to the
 * browser both reads as a crash and hands out the schema. The full error is
 * still logged server-side.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, detail: err.detail });
    return;
  }

  console.error(err);
  const raw = err instanceof Error ? err.message : '';

  if (/UNIQUE constraint failed/i.test(raw)) {
    res.status(409).json({ error: 'That value is already taken by another record.' });
    return;
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    res.status(409).json({ error: 'That record is still referenced by something else.' });
    return;
  }
  if (/CHECK constraint failed/i.test(raw)) {
    res.status(400).json({ error: 'That value is not one this field accepts.' });
    return;
  }
  if (/SQLITE_|LIBSQL_|no such (table|column)/i.test(raw)) {
    res.status(500).json({ error: 'The database rejected that request. Check the server log for details.' });
    return;
  }

  res.status(500).json({ error: raw || 'Something went wrong' });
}
