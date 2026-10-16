import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWikiMcpServer } from '../src/tools.ts';
import { WikiIndex } from '../src/search.ts';
import { createApp } from '../../annotation-server/src/server.ts';
import { loadConfig } from '../../annotation-server/src/config.ts';
import { AnnotationStore } from '../../annotation-server/src/store.ts';
import { AuthService } from '../../annotation-server/src/auth.ts';
import { PageTextIndex } from '../../annotation-server/src/index-store.ts';
import { HighlightService } from '../../annotation-server/src/highlight/index.ts';
import { JevJudge } from '../../annotation-server/src/highlight/jev-provider.ts';
import { LlmJudge } from '../../annotation-server/src/highlight/llm-provider.ts';

const { AnnotationReader } = await import(process.env.AIPM_REVIEW_READER
  ? pathToFileURL(resolve(process.env.AIPM_REVIEW_READER)).href
  : new URL('../src/annotation-reader.ts', import.meta.url).href);
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const config = loadConfig({ DATA_DIR: resolve(output, randomUUID()), SITE_BASE: 'http://127.0.0.1',
  SEARCH_INDEX_URL: 'http://127.0.0.1:1/unused', GITHUB_CLIENT_ID: 'offline-review',
  GITHUB_CLIENT_SECRET: 'unused', DEV_AUTH_BYPASS: 'false' });
const store = new AnnotationStore(config.dataDir);
await store.load();
const now = new Date().toISOString();
const quote = 'review-quotation-'.repeat(25);
const record = { id: randomUUID(), page: '/ai/rag/', visibility: 'public', color: 'yellow',
  style: 'highlight', body: '', author: { githubId: 701, login: 'offline-review' },
  target: { selectors: [{ type: 'TextQuoteSelector', exact: quote, prefix: 'P'.repeat(300), suffix: 'S'.repeat(300) }] },
  replies: [], likes: [], createdAt: now, updatedAt: now };
const elsewhere = { ...record, id: randomUUID(), page: '/ai/other/',
  target: { selectors: [{ type: 'TextQuoteSelector', exact: 'OTHER_ARTICLE_QUOTE' }] } };
const privateRecord = { ...record, id: randomUUID(), visibility: 'private',
  target: { selectors: [{ type: 'TextQuoteSelector', exact: 'PRIVATE_QUOTE' }] } };
store.setAnnotations([record, elsewhere, privateRecord]);
await store.flush();
const index = new PageTextIndex(config.searchIndexUrl, config.indexRefreshMs);
const highlight = new HighlightService({ config, index, judges: {
  jev: new JevJudge({ apiKey: '', baseUrl: 'http://127.0.0.1:1', model: 'unused', timeoutMs: 1000 }),
  llm: new LlmJudge({ apiKey: '', model: 'unused', maxTokens: 1, timeoutMs: 1000 }),
} });
const { server } = createApp({ config, store, index, highlight, auth: new AuthService(config, store) });
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const base = `http://127.0.0.1:${server.address().port}`;
const mcp = createWikiMcpServer({ index: WikiIndex.fromDocs([{ location: 'ai/rag/', title: 'Review', text: quote }]),
  proposalPage: '/ai/rag/', annotationReader: new AnnotationReader({ apiBase: base, apiKey: '', page: '/ai/rag/', token: null, signal: AbortSignal.timeout(10000) }) });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'quotation-regression', version: '1' });
await mcp.instance.connect(serverTransport);
await client.connect(clientTransport);
const evidence = { modelRequests: 0 };
try {
  const raw = await (await fetch(`${base}/api/annotations/${record.id}`)).json();
  assert.equal(raw.annotation.target.selectors[0].exact, quote);
  const list = await client.callTool({ name: 'list_article_annotations', arguments: {} });
  const thread = await client.callTool({ name: 'read_annotation_thread', arguments: { annotation_id: record.id } });
  Object.assign(evidence, { raw, list, thread });
  const resultText = result => result.content.find(block => block.type === 'text').text;
  const resultJson = result => JSON.parse(resultText(result).slice(resultText(result).indexOf('\n') + 1));
  const listRecord = resultJson(list).annotations[0];
  const threadRecord = resultJson(thread).annotation;
  assert.equal(listRecord.quote, quote.slice(0, 240));
  assert.equal(listRecord.quoteTruncated, true);
  assert.equal(threadRecord.quote, quote);
  assert.equal(threadRecord.prefix.length, 200);
  assert.equal(threadRecord.suffix.length, 200);
  assert.equal(threadRecord.quoteTruncated, false);
  for (const hidden of [elsewhere, privateRecord]) {
    const response = await client.callTool({ name: 'read_annotation_thread', arguments: { annotation_id: hidden.id } });
    assert.ok(!resultText(response).includes(hidden.target.selectors[0].exact));
  }
  assert.ok(!resultText(list).includes('PRIVATE_QUOTE'));
  assert.ok(!resultText(list).includes('OTHER_ARTICLE_QUOTE'));
  evidence.status = 'pass';
  console.log('PASS quotation, preview bounds, context bounds and invisible quotation exclusion');
} catch (error) {
  evidence.status = 'fail';
  evidence.error = error.message;
  throw error;
} finally {
  await writeFile(resolve(output, 'quotation.json'), JSON.stringify(evidence, null, 2));
  await client.close();
  await mcp.instance.close();
  server.closeAllConnections();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
