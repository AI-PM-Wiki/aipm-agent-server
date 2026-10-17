import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [source, root, output, baseUrl] = process.argv.slice(2);
const { runAgent } = await import(pathToFileURL(source + '/dist/agent.js'));
const { loadConfig } = await import(pathToFileURL(source + '/dist/config.js'));
const { WikiIndex, parseIndexPayload } = await import(pathToFileURL(source + '/dist/search.js'));
const input = JSON.parse(readFileSync(root + '/png-ui-01a1494c-ready/plan/meta/image-direct-01a1472a/prepared/product-input.json'));
const index = WikiIndex.fromDocs(parseIndexPayload(JSON.parse(readFileSync(root + '/aipm-wt-svg-native-01a14992/meta/svg-site/search/search_index.json'))), 'http://127.0.0.1:8000');
const config = loadConfig({ ANTHROPIC_API_KEY: 'local-capture-only', ANTHROPIC_BASE_URL: baseUrl,
  SYSTEM_PROMPT_UPDATE: 'in-history', MODEL: 'deepseek-flash', EFFORT: 'medium', MAX_TURNS: '1',
  MAX_BUDGET_USD: '0.3', SCRATCH_DIR: output + '/scratch', SITE_BASE: 'http://127.0.0.1:8000',
  ANNOTATION_API_BASE: 'http://127.0.0.1:1' });
const controller = new AbortController();
process.on('message', message => { assert.equal(message, 'captured'); controller.abort(); });
const timer = setTimeout(() => controller.abort(), 20000);
try {
  const outcome = await runAgent({ ...input, proposalPage: '/ai/rag/', annotationPage: '/ai/rag/', config, index,
    signal: controller.signal, callbacks: { onDelta() { assert.fail('unexpected_response'); }, onThinking() { assert.fail('unexpected_response'); },
      onSources() { assert.fail('unexpected_tool'); }, onProposal() { assert.fail('unexpected_tool'); } } });
  assert.equal(outcome.ok, false);
  writeFileSync(output + '/outcome.json', JSON.stringify({ ok: outcome.ok, code: outcome.code, capturedThenAborted: controller.signal.aborted }));
} finally { clearTimeout(timer); index.stop(); process.disconnect(); }
