import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function realModelRecorder() {
  const required = ['AIPM_REAL_MODEL_API_KEY', 'AIPM_REAL_MODEL_BASE_URL', 'AIPM_REAL_MODEL_NAME'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`authorized real model configuration missing: ${missing.join(', ')}`);
  const apiKey = process.env.AIPM_REAL_MODEL_API_KEY!;
  const upstream = new URL(process.env.AIPM_REAL_MODEL_BASE_URL!);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('real model provider must be an HTTPS URL without credentials, query, or fragment');
  }
  const captured: { path: string; body: Record<string, unknown> }[] = [];
  const responses: { status: number; requestId: string | null }[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = Buffer.concat(chunks);
      const path = req.url!;
      const body = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      captured.push({ path, body });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value && !['host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'x-api-key'].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }
      headers.set('x-api-key', apiKey);
      const response = await fetch(upstream.href.replace(/\/$/, '') + path, {
        method: req.method, headers, body: payload, signal: AbortSignal.timeout(180_000),
      });
      responses.push({ status: response.status, requestId: response.headers.get('request-id') ?? response.headers.get('x-request-id') });
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (!['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(name)) res.setHeader(name, value);
      });
      if (!response.body) throw new Error('real model provider response has no body');
      await pipeline(Readable.fromWeb(response.body), res);
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ANTHROPIC_API_KEY = apiKey;
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return { server, captured, responses, base, apiKey, model: process.env.AIPM_REAL_MODEL_NAME! };
}
