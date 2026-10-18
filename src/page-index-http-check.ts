#!/usr/bin/env node
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { WikiIndex } from './search.ts';
import { INDEX_UNAVAILABLE, resolveRequestPage } from './annotation-proposal.ts';
import { createApp } from './server.ts';

const payload = await readFile(new URL('../../site/search/search_index.json', import.meta.url));
let sourceState: 'healthy' | 'empty' | 'unavailable' = 'unavailable';
const source = createServer((_req, res) => {
  if (sourceState === 'unavailable') {
    res.writeHead(503).end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(sourceState === 'empty' ? JSON.stringify({ docs: [] }) : payload);
});
source.listen(0, '127.0.0.1');
await once(source, 'listening');
const sourcePort = (source.address() as { port: number }).port;
const index = new WikiIndex(`http://127.0.0.1:${sourcePort}/search_index.json`, 0, 'https://aipm.ac');
const config = loadConfig({
  ANTHROPIC_API_KEY: 'local-index-check-no-model-call',
  SCRATCH_DIR: new URL('../meta/runtime/scratch', import.meta.url).pathname,
  SITE_BASE: 'https://aipm.ac/',
  RATE_LIMIT_MAX: '1000',
});
const { server } = createApp({ config, index });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;

async function post(body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '给这篇文章提建议', ...body }),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.json() as { error: string; message: string },
  };
}

async function unavailable(label: string) {
  assert.equal(index.getStats().docCount, 0, label);
  assert.equal(resolveRequestPage('/ai/rag/', [], index, config.siteBase), INDEX_UNAVAILABLE);
  for (const body of [
    { page: '/ai/rag/' },
    { context: [{ kind: 'selection', page: '/ai/rag/', title: '检索增强生成', quote: '原文', prefix: '', suffix: '', body: '', color: '', chart: '', source: '', visibility: 'public' }] },
    { page: '/missing/' },
  ]) {
    const result = await post(body);
    assert.equal(result.status, 503, label);
    assert.equal(result.body.error, 'index_unavailable', label);
    assert.match(result.body.message, /文章索引暂不可用/);
    assert.equal(result.retryAfter, '10');
  }
  for (const body of [
    { page: '//evil.example/' },
    { page: '/ai/../rag/' },
    { page: '/ai/%2e%2e/rag/' },
    { page: '/ai/rag/?x=1' },
    { page: '/ai/rag/', context: [{ kind: 'selection', page: '/ai/prompting/', title: '提示词', quote: '原文', prefix: '', suffix: '', body: '', color: '', chart: '', source: '', visibility: 'public' }] },
  ]) {
    const result = await post(body);
    assert.equal(result.status, 400, label);
    assert.equal(result.body.error, 'bad_request', label);
  }
  console.log(`PASS ${label}`);
}

try {
  await assert.rejects(index.load(), /HTTP 503/);
  await unavailable('首次加载失败');

  sourceState = 'healthy';
  await index.load();
  assert.ok(index.getStats().docCount > 0);
  assert.equal(resolveRequestPage('/ai/rag/', [], index, config.siteBase), '/ai/rag/');
  let result = await post({ page: '/missing/' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'bad_request');

  sourceState = 'unavailable';
  await index.refresh();
  assert.equal(index.getStats().stale, true);
  assert.ok(index.getStats().docCount > 0);
  assert.equal(resolveRequestPage('/ai/rag/', [], index, config.siteBase), '/ai/rag/');
  result = await post({ page: '/missing/' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'bad_request');
  console.log('PASS 非空缓存刷新失败');

  sourceState = 'empty';
  await index.refresh();
  assert.equal(index.getStats().stale, false);
  await unavailable('加载空索引');

  sourceState = 'unavailable';
  await index.refresh();
  assert.equal(index.getStats().stale, true);
  await unavailable('空索引刷新失败');

  sourceState = 'healthy';
  await index.refresh();
  assert.equal(index.getStats().stale, false);
  assert.equal(resolveRequestPage('/ai/rag/', [], index, config.siteBase), '/ai/rag/');
  result = await post({ page: '/missing/' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'bad_request');
  console.log('PASS 恢复非空索引');
} finally {
  server.close();
  source.close();
  await Promise.all([once(server, 'close'), once(source, 'close')]);
}
