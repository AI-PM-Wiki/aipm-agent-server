import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.ts';
import { SummarySchema, summaryRevision, validateSummary } from './article-summary.ts';
import { WikiIndex } from './search.ts';
import { createApp } from './server.ts';
import { buildPromptInput } from './agent.ts';

const directory = process.argv[2];
const envFile = process.argv[3];
assert.ok(directory && envFile, 'provide acceptance directory and authorized environment file');
process.loadEnvFile(envFile);
const runtime = JSON.parse(await readFile(join(directory, 'runtime-config.json'), 'utf8'));
const accepted = JSON.parse(await readFile(join(directory, 'http-results.json'), 'utf8'));
const summary = SummarySchema.parse(JSON.parse(await readFile(join(directory, 'summaries', accepted.revision + '.json'), 'utf8')));
const index = new WikiIndex(runtime.site + '/search/search_index.json', 0, runtime.site);
await index.load();
const article = index.readSummaryArticle(summary.page);
assert.ok(article);
assert.ok(article.text.length > 12000);
assert.equal(summaryRevision(article, summary.model), summary.revision);
assert.notEqual(summaryRevision({ ...article, text: article.text + '\n' }, summary.model), summary.revision);
assert.notEqual(summaryRevision(article, summary.model + '-different'), summary.revision);
validateSummary(summary, article, summary.revision);
const prompt = buildPromptInput('继续讨论', [], [], runtime.site, summary.page, summary);
assert.equal(typeof prompt, 'string');
assert.ok((prompt as string).includes(summary.reading.sections.at(-1)!.explanation));
assert.throws(() => validateSummary({ ...summary, page: '/missing/' }, article, summary.revision));
assert.throws(() => validateSummary({ ...summary, mindmap: { branches: [
  { ...summary.mindmap.branches[0]!, anchor: 'unlisted-source-anchor' },
] } }, article, summary.revision));
const config = loadConfig({
  ...process.env,
  ANTHROPIC_API_KEY: process.env.AIPM_REAL_MODEL_API_KEY,
  ANTHROPIC_BASE_URL: process.env.AIPM_REAL_MODEL_BASE_URL,
  SUMMARY_MODEL: summary.model,
  SUMMARY_CACHE_DIR: join(directory, 'summaries'),
  SITE_BASE: runtime.site,
  ALLOWED_ORIGINS: runtime.site,
  API_KEY: randomUUID(),
  MAX_BUDGET_USD: '0.000001', DAILY_BUDGET_USD: '0.000001',
  RATE_LIMIT_MAX: '100', SCRATCH_DIR: join(directory, 'scratch'),
});
const { server } = createApp({ config, index });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
const headers = { 'X-API-Key': config.apiKey };
try {
  assert.equal((await fetch(base + '/api/summary?page=/ai/rag/')).status, 401);
  const denied = await fetch(base + '/api/summary?page=/ai/rag/', { headers: { Origin: 'https://example.com' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  const cached = await fetch(base + '/api/summary?page=/ai/rag/', { headers });
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), summary);
  const budget = await fetch(base + '/api/summary?page=/ai/rag-retrieval/', { headers });
  assert.equal(budget.status, 429);
  assert.equal((await budget.json() as { error: string }).error, 'budget_exhausted');
  assert.ok(Number(budget.headers.get('Retry-After')) > 0);
  const stale = await fetch(base + '/api/chat', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '继续讨论', page: summary.page, summaryRevision: '0'.repeat(64) }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: string }).error, 'summary_stale');
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const limited = createApp({ config: { ...config, rateLimitMax: 1 }, index }).server;
await new Promise<void>(resolve => limited.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = 'http://127.0.0.1:' + (limited.address() as AddressInfo).port + '/api/summary?page=/ai/rag/';
  assert.equal((await fetch(endpoint, { headers })).status, 200);
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 429);
  assert.equal((await response.json() as { error: string }).error, 'rate_limited');
  assert.ok(Number(response.headers.get('Retry-After')) > 0);
} finally {
  await new Promise<void>((resolve, reject) => limited.close(error => error ? reject(error) : resolve()));
}
const results = { sourceChangesInvalidateCache: true, modelChangesInvalidateCache: true,
  invalidAnchorsRejected: true, apiKey: true, cors: true, cacheAvailableAfterBudgetExhaustion: true,
  generationBudget: true, rateLimit: true, completeSummaryInPrompt: true, staleSummaryRejected: true };
await writeFile(join(directory, 'service-boundaries.json'), JSON.stringify(results, null, 2));
console.log(results);
