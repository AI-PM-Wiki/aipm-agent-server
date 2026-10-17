import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { completeHistorySystem as adapt } from '../dist/system-prompt-adapter.js';
import { SYSTEM_PROMPT } from '../dist/agent.js';
import { WIKI_MCP_INSTRUCTIONS } from '../dist/tools.js';

const [root, output] = process.argv.slice(2);
assert.ok(root && output);
const original = JSON.parse(readFileSync(root + '/png-ui-01a1494c-ready/product-request.body'));
const snapshot = Object.freeze({ wiki: WIKI_MCP_INSTRUCTIONS });
const completeHistorySystem = (body, strategy, prompt) => adapt(body, strategy, prompt, snapshot);
const results = [];
function check(name, run) {
  try { run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, reason: error.message.split('\n')[0] }); }
}

check('active_mcp_instructions_survive_budget_only_update', () => {
  const instruction = '可用 list_article_annotations 和 read_annotation_thread 读取当前文章的已有讨论。';
  assert.ok(original.messages[1].content.includes(instruction));
  const body = structuredClone(original);
  body.messages.push({ role: 'user', content: 'explicit offline input state' },
    { role: 'system', content: 'USD budget: $0.1/$0.3; $0.2 remaining' });
  const changed = completeHistorySystem(body, 'in-history', SYSTEM_PROMPT);
  assert.ok(changed.messages.at(-1).content.includes(instruction), 'active_mcp_instructions_missing');
});

function sequence(budgets) {
  const body = structuredClone(original);
  for (const budget of budgets) body.messages.push({ role: 'user', content: 'explicit offline input state' },
    { role: 'system', content: budget });
  return body;
}
function text(body) {
  const content = body.messages.at(-1).content;
  return typeof content === 'string' ? content : content.map(block => block.text).join('\n\n');
}
const budgets = ['USD budget: $0.1/$0.3; $0.2 remaining', 'USD budget: $0.2/$0.3; $0.1 remaining',
  'USD budget: $0.25/$0.3; $0.05 remaining'];
check('consecutive_budgets_keep_current_instructions_only_latest_budget', () => {
  for (let i = 0; i < budgets.length; i++) {
    const body = sequence(budgets.slice(0, i + 1));
    const changed = completeHistorySystem(body, 'in-history', SYSTEM_PROMPT);
    const latest = text(changed);
    assert.ok(latest.includes(SYSTEM_PROMPT));
    assert.ok(latest.includes(WIKI_MCP_INSTRUCTIONS));
    assert.ok(latest.includes(budgets[i]));
    for (const expired of budgets.slice(0, i)) assert.equal(latest.includes(expired), false);
    for (const expired of original.messages[1].content.split('\n').filter(line => line.startsWith('USD budget:') || line.startsWith('<total_tokens>')))
      assert.equal(latest.includes(expired), false);
    assert.equal(latest.includes(original.messages[1].content), false);
    assert.deepEqual(completeHistorySystem(changed, 'in-history', SYSTEM_PROMPT), changed);
    assert.deepEqual({ ...changed, messages: body.messages }, body);
    assert.deepEqual(changed.messages.map(m => m.role), body.messages.map(m => m.role));
    changed.messages.forEach((message, index) => {
      if (message.role !== 'system') assert.equal(JSON.stringify(message), JSON.stringify(body.messages[index]));
    });
  }
});
check('snapshot_update_replaces_instructions_without_history_accumulation', () => {
  const body = sequence(budgets);
  const active = { wiki: 'Current instructions version two.' };
  const changed = adapt(body, 'in-history', SYSTEM_PROMPT, active);
  assert.ok(text(changed).includes(active.wiki));
  assert.equal(text(changed).includes(WIKI_MCP_INSTRUCTIONS), false);
  assert.ok(text(changed).includes(budgets.at(-1)));
  assert.deepEqual(adapt(changed, 'in-history', SYSTEM_PROMPT, active), changed);
});
check('explicit_empty_snapshot_removes_instructions', () => {
  const body = sequence(budgets);
  const changed = adapt(body, 'in-history', SYSTEM_PROMPT, {});
  assert.equal(text(changed), SYSTEM_PROMPT + '\n\n' + budgets.at(-1));
  assert.deepEqual(adapt(changed, 'in-history', SYSTEM_PROMPT, {}), changed);
});
check('updated_sdk_announcement_matches_current_configuration', () => {
  const body = sequence([]);
  const active = { wiki: 'Current instructions version two.' };
  body.messages.push({ role: 'system', content: original.messages[1].content.replace(WIKI_MCP_INSTRUCTIONS, active.wiki) });
  const changed = adapt(body, 'in-history', SYSTEM_PROMPT, active);
  assert.equal(text(changed), SYSTEM_PROMPT + '\n\n' + body.messages.at(-1).content);
  assert.equal(text(changed).includes(WIKI_MCP_INSTRUCTIONS), false);
});
check('sdk_removal_notice_with_empty_configuration', () => {
  const body = sequence([]);
  body.messages.push({ role: 'system', content: 'The following MCP servers have disconnected. Their instructions above no longer apply:\nwiki\n\n' + budgets[0] });
  const changed = adapt(body, 'in-history', SYSTEM_PROMPT, {});
  assert.equal(text(changed), SYSTEM_PROMPT + '\n\n' + body.messages.at(-1).content);
  assert.throws(() => adapt(body, 'in-history', SYSTEM_PROMPT, snapshot), /mcp_instructions_removal_requires_reconciled_snapshot/);
});
check('sessions_use_independent_snapshots_and_inputs', () => {
  const body = sequence(budgets);
  const saved = structuredClone(body);
  const a = adapt(body, 'in-history', SYSTEM_PROMPT, { wiki: 'Session A instructions.' });
  const b = adapt(body, 'in-history', SYSTEM_PROMPT, { wiki: 'Session B instructions.' });
  assert.ok(text(a).includes('Session A instructions.'));
  assert.equal(text(a).includes('Session B instructions.'), false);
  assert.ok(text(b).includes('Session B instructions.'));
  assert.equal(text(b).includes('Session A instructions.'), false);
  assert.deepEqual(adapt(body, 'in-history', SYSTEM_PROMPT, { wiki: 'Session A instructions.' }), a);
  assert.deepEqual(body, saved);
});
check('cached_blocks_and_repeated_serialized_adaptation', () => {
  const body = sequence([]);
  body.messages.push({ role: 'system', content: [{ type: 'text', text: budgets[2], cache_control: { type: 'ephemeral' } }] });
  const changed = completeHistorySystem(body, 'in-history', SYSTEM_PROMPT);
  assert.deepEqual(changed.messages.at(-1).content.at(-1), body.messages.at(-1).content[0]);
  assert.ok(text(changed).includes(WIKI_MCP_INSTRUCTIONS));
  assert.deepEqual(completeHistorySystem(JSON.parse(JSON.stringify(changed)), 'in-history', SYSTEM_PROMPT), changed);
});
check('unrelated_strategy_unchanged_without_snapshot', () => {
  for (const strategy of [undefined, 'leading-only', 'unrecognized']) assert.equal(adapt(original, strategy, SYSTEM_PROMPT), original);
});
check('missing_or_malformed_snapshot_rejected', () => {
  for (const invalid of [undefined, null, [], { wiki: null }, { wiki: '' }])
    assert.throws(() => adapt(original, 'in-history', SYSTEM_PROMPT, invalid));
});
check('stale_announcement_conflicting_with_snapshot_rejected', () => {
  assert.throws(() => adapt(original, 'in-history', SYSTEM_PROMPT, {}), /mcp_instructions_snapshot_mismatch/);
  assert.throws(() => adapt(original, 'in-history', SYSTEM_PROMPT, { wiki: 'different instructions' }), /mcp_instructions_snapshot_mismatch/);
  const changed = structuredClone(original);
  changed.messages[1].content = changed.messages[1].content.replace(WIKI_MCP_INSTRUCTIONS, WIKI_MCP_INSTRUCTIONS + ' additional instruction');
  assert.throws(() => adapt(changed, 'in-history', SYSTEM_PROMPT, snapshot), /mcp_instructions_snapshot_mismatch/);
});

writeFileSync(output, JSON.stringify({ scope: 'offline input state; reviewer input and assertion', results,
  upstreamGeneration: 0, capabilityQueries: 0, jevCalls: 0 }, null, 2), { flag: 'wx' });
console.log(JSON.stringify(results));
if (results.some(result => !result.passed)) process.exitCode = 1;
