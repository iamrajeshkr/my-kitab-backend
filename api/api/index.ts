import app from '../src/app.js';

// Vercel Node.js Serverless Function entrypoint.
//
// We DON'T use @hono/node-server/vercel's handle here: it builds a streaming
// Request (duplex:'half') from the Node req, and reading that stream hangs on
// Vercel's runtime, so `c.req.json()` never resolves (POST bodies time out).
// Instead we buffer the body eagerly and hand Hono a plain Web Request.
export default async function handler(req: any, res: any) {
  const method: string = req.method ?? 'GET';

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (Array.isArray(v)) v.forEach((val) => headers.append(k, String(val)));
    else if (v != null) headers.set(k, String(v));
  }

  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (chunks.length) body = Buffer.concat(chunks);
  }

  const proto = (req.headers?.['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers?.['x-forwarded-host'] as string) || req.headers?.host || 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  const request = new Request(url, { method, headers, body });
  const response = await app.fetch(request);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}
