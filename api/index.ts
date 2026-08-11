import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/app.js';

/**
 * Vercel entry point. Every `/api/*` request is rewritten here (see
 * vercel.json) and handed to the same Express app the local server runs, so
 * there is no second implementation to keep in step.
 *
 * The app is built once per warm instance rather than per request.
 */
const app = createApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return (app as unknown as (r: IncomingMessage, s: ServerResponse) => void)(req, res);
}
