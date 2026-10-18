#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './server.ts';
import { loadConfig } from './config.ts';
import { WikiIndex } from './search.ts';

const frontend = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><body>Retry-After acceptance</body></html>');
});
frontend.listen(0, '127.0.0.1');
await once(frontend, 'listening');
const frontendAddress = frontend.address();
assert.ok(frontendAddress && typeof frontendAddress !== 'string');
const allowedOrigin = `http://127.0.0.1:${frontendAddress.port}`;
const config = loadConfig({
  ANTHROPIC_API_KEY: 'retry-after-check-no-model-call',
  ALLOWED_ORIGINS: allowedOrigin,
  SITE_BASE: 'https://aipm.ac',
  RATE_LIMIT_MAX: '1',
  RATE_LIMIT_WINDOW_MS: '1000',
});
const { server } = createApp({ config, index: WikiIndex.fromDocs([]) });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}/api/chat`;

async function post(origin: string | undefined): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (origin !== undefined) headers.set('Origin', origin);
  return fetch(endpoint, { method: 'POST', headers, body: '{}' });
}

try {
  if (process.env.RUN_RETRY_AFTER_BROWSER === 'true') {
    const python = process.env.PLAYWRIGHT_PYTHON ?? 'python3';
    const browserCheck = spawn(python, [join(import.meta.dirname, '../test/retry-after-browser-check.py')], {
      env: {
        ...process.env,
        RETRY_AFTER_API_BASE: `http://127.0.0.1:${address.port}`,
        RETRY_AFTER_BROWSER_ORIGIN: allowedOrigin,
      },
      stdio: 'inherit',
    });
    const [code] = await once(browserCheck, 'exit') as [number | null];
    assert.equal(code, 0, 'Chromium Retry-After regression failed');
  } else {
    const first = await post(allowedOrigin);
    assert.equal(first.status, 400);
    const blocked = await post(allowedOrigin);
    assert.equal(blocked.status, 429);
    const retryAfter = blocked.headers.get('retry-after');
    assert.ok(retryAfter && Number(retryAfter) > 0);
    assert.equal(blocked.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.equal(blocked.headers.get('access-control-expose-headers'), 'Retry-After');

    const foreign = await post('https://outside.example');
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    assert.equal(foreign.headers.get('access-control-expose-headers'), null);

    await new Promise((resolve) => setTimeout(resolve, Number(retryAfter) * 1000 + 100));
    const recovered = await post(allowedOrigin);
    assert.equal(recovered.status, 400);
    assert.equal((await recovered.json() as { error: string }).error, 'bad_request');
    console.log(`PASS Retry-After=${retryAfter}s; allowed Origin exposes header; foreign Origin cannot read it`);
    console.log('PASS rate window released; recovery request stopped at validation before model execution');
  }
} finally {
  server.close();
  frontend.close();
  await Promise.all([once(server, 'close'), once(frontend, 'close')]);
}
