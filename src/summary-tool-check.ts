import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseIndexPayload, WikiIndex } from './search.ts';
import { createWikiMcpServer } from './tools.ts';
import type { McpServerDeps } from './tools.ts';
import { ArticleSummaryService, SummarySchema } from './article-summary.ts';
import { DailyBudget } from './budget.ts';
import { Semaphore } from './rate-limit.ts';
import { loadConfig } from './config.ts';
import { ChatBodySchema } from './server.ts';
import { renderContext } from './context.ts';

const indexPath = process.argv[2];
assert.ok(indexPath, 'provide the built search index');
const index = WikiIndex.fromDocs(parseIndexPayload(JSON.parse(await readFile(indexPath, 'utf8'))));
const directory = process.argv[3];
const deps: McpServerDeps = { index, proposalPage: '/ai/rag/', annotationReader: null };
const events: unknown[] = [];
let expected;
if (directory) {
  assert.ok(process.argv[4], 'provide the authorized model environment file');
  process.loadEnvFile(process.argv[4]);
  const accepted = JSON.parse(await readFile(join(directory, 'http-results.json'), 'utf8'));
  expected = SummarySchema.parse(JSON.parse(await readFile(join(directory, 'summaries', accepted.revision + '.json'), 'utf8')));
  const config = loadConfig({
    ANTHROPIC_API_KEY: process.env.AIPM_REAL_MODEL_API_KEY,
    ANTHROPIC_BASE_URL: process.env.AIPM_REAL_MODEL_BASE_URL, SUMMARY_MODEL: expected.model,
    SUMMARY_CACHE_DIR: join(directory, 'summaries'), SCRATCH_DIR: join(directory, 'scratch'),
    MAX_BUDGET_USD: '0', DAILY_BUDGET_USD: '0',
  });
  deps.summaries = new ArticleSummaryService(config, new DailyBudget(0), new Semaphore(1));
  deps.onSummary = event => events.push(event);
}
const server = createWikiMcpServer(deps);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'summary-tool-check', version: '1.0.0' });
await server.instance.connect(serverTransport);
await client.connect(clientTransport);
try {
  const { tools } = await client.listTools();
  const summaryTool = tools.find(tool => tool.name === 'show_article_summary');
  assert.ok(summaryTool, 'Agent must expose the article mindmap and reading tool');
  assert.deepEqual(Object.keys(summaryTool.inputSchema.properties ?? {}), ['view']);
  console.log('PASS article summary tool is available to the Agent');
  const invalid = await client.callTool({ name: 'show_article_summary', arguments: { view: 'unknown' } });
  assert.equal(invalid.isError, true);
  if (expected) {
    for (const view of ['mindmap', 'reading']) {
      const result = await client.callTool({ name: 'show_article_summary', arguments: { view } });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(JSON.stringify(result).includes(expected.reading.overview));
      assert.deepEqual(events.at(-1), { summary: expected, view });
    }
    assert.equal(events.length, 2);
    const unboundServer = createWikiMcpServer({ ...deps, proposalPage: null });
    const [unboundClientTransport, unboundServerTransport] = InMemoryTransport.createLinkedPair();
    const unboundClient = new Client({ name: 'unbound-summary-check', version: '1.0.0' });
    await unboundServer.instance.connect(unboundServerTransport);
    await unboundClient.connect(unboundClientTransport);
    try {
      const unbound = await unboundClient.callTool({ name: 'show_article_summary', arguments: { view: 'mindmap' } });
      assert.equal(unbound.isError, true);
      assert.equal(events.length, 2);
    } finally {
      await unboundClient.close();
      await unboundServer.instance.close();
    }
    const controller = new AbortController();
    controller.abort();
    deps.signal = controller.signal;
    const cancelled = await client.callTool({ name: 'show_article_summary', arguments: { view: 'reading' } });
    assert.equal(cancelled.isError, true);
    assert.equal(events.length, 2);

    const section = expected.reading.sections[0]!;
    const body = { message: '解释这个主题', page: expected.page, summaryRevision: expected.revision,
      context: [{ kind: 'summary', page: expected.page, source: section.heading + '\n' + section.explanation }] };
    const parsed = ChatBodySchema.parse(body);
    const context = renderContext(parsed.context, 'https://aipm.ac');
    assert.ok(context.includes(section.explanation));
    assert.ok(context.includes('AI 生成'));
    assert.ok(!context.includes('原文: “'));
    assert.equal(ChatBodySchema.safeParse({ ...body, context: [{ ...body.context[0], source: ' ' }] }).success, false);
    assert.equal(ChatBodySchema.safeParse({ ...body, context: [{ ...body.context[0], visibility: 'local' }] }).success, false);
    console.log('PASS both views reuse the accepted model cache; invalid input and cancellation emit no view');
    console.log('PASS selected summary topics reach the prompt as generated reference material');
  } else {
    const unavailable = await client.callTool({ name: 'show_article_summary', arguments: { view: 'reading' } });
    assert.equal(unavailable.isError, true);
  }
} finally {
  await client.close();
  await server.instance.close();
}
