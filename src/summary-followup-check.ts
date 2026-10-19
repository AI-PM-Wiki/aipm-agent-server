import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runAgent } from './agent.ts';
import { ArticleSummaryService, SummarySchema } from './article-summary.ts';
import { DailyBudget } from './budget.ts';
import { loadConfig } from './config.ts';
import { Semaphore } from './rate-limit.ts';
import { parseIndexPayload, WikiIndex } from './search.ts';
import type { ArticleSummaryEvent } from './tools.ts';

const [indexSource, summaryPath, workDirectory, envFile] = process.argv.slice(2);
assert.ok(indexSource && summaryPath && workDirectory,
  'provide the index file or HTTPS URL, real summary file, work directory, and optional model environment file');
const env = { ...process.env };
if (envFile) {
  process.loadEnvFile(envFile);
  env.ANTHROPIC_API_KEY = process.env.AIPM_REAL_MODEL_API_KEY;
  env.ANTHROPIC_BASE_URL = process.env.AIPM_REAL_MODEL_BASE_URL;
  env.MODEL = process.env.AIPM_REAL_MODEL_NAME;
}
const summary = SummarySchema.parse(JSON.parse(await readFile(summaryPath, 'utf8')));
assert.equal(env.MODEL, summary.model, 'the configured real model must match the accepted summary');
const config = loadConfig({
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
  MODEL: summary.model, SUMMARY_MODEL: summary.model,
  SUMMARY_CACHE_DIR: dirname(summaryPath),
  SCRATCH_DIR: join(workDirectory, 'scratch'),
  BODY_LIMIT_BYTES: '65536', SYSTEM_PROMPT_UPDATE: 'in-history', MAX_RUN_MS: '25000',
});
const indexUrl = URL.canParse(indexSource) ? new URL(indexSource) : null;
if (indexUrl) assert.equal(indexUrl.protocol, 'https:');
const index = indexUrl
  ? new WikiIndex(indexUrl.href, config.indexRefreshMs, config.siteBase)
  : WikiIndex.fromDocs(parseIndexPayload(JSON.parse(await readFile(indexSource, 'utf8'))));
if (indexUrl) await index.load();
const summaries = new ArticleSummaryService(config, new DailyBudget(config.dailyBudgetUsd),
  new Semaphore(config.concurrencyLimit));
const events: ArticleSummaryEvent[] = [];
let answer = '';
const outcome = await runAgent({
  message: '请展示当前文章的 AI 精读，并读取当前文章的全文核对，最后简要说明。',
  history: [], summary, summaries, proposalPage: summary.page, annotationPage: summary.page,
  config, index, signal: AbortSignal.timeout(config.maxRunMs),
  callbacks: {
    onDelta: text => { answer += text; },
    onThinking: () => {}, onSources: () => {},
    onSummary: event => { events.push(event); },
    onStderr: line => process.stderr.write(line),
  },
});
assert.equal(outcome.ok, true, JSON.stringify(outcome));
assert.ok(events.some(event => event.view === 'reading' && event.summary.revision === summary.revision));
assert.ok(answer.trim().length > 0);
console.log('PASS real model completes article reading with summary context and a 64 KiB client body limit');
console.log(JSON.stringify({ durationMs: outcome.durationMs, answerChars: answer.length, views: events.length }));
