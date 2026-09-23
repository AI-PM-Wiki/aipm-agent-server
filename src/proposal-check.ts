#!/usr/bin/env node
/**
 * 「Agent 提批注建议」那条通路的动态回归:建议**确实**从工具走到了回调,而且
 * 模型的输出扩不了权。
 *
 *   npm run proposal-check
 *
 * 造法:起一个假的模型 API,把 ANTHROPIC_BASE_URL 指到它,然后**真跑一轮**
 * runAgent —— 真 SDK、真 CLI 子进程、真 MCP 工具调用、真 HTTP 请求。假 API 按
 * 脚本回 tool_use,把收到的请求体抄下来。于是断言的对象不是我们自己的中间变量,
 * 而是模型真正收到的那个字节流与工具真正收到的参数。
 *
 * 不联网、不需要 ANTHROPIC_API_KEY(配置里塞的是假 key,索引是空的 WikiIndex)。
 *
 * 覆盖:
 *  - 一条合规的建议 → 回调收到它,页面是语境的页面(model 参数里没有 page);
 *  - 回给模型的结果明说「还没有写入」;
 *  - 模型自己塞 page / author:id 之类的键 → 当场是错误结果,没有建议成型;
 *  - 可见范围、粒度、引文那几条规则:不合规的不成型;
 *  - 请求缺少页面及语境时拒绝建议;
 *  - 一轮超过上限:超出的部分回错误,不静默丢掉。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { WikiIndex } from './search.ts';
import { runAgent } from './agent.ts';
import type { ContextItem } from './context.ts';
import { PROPOSAL_MAX_ITEMS } from './annotation-proposal.ts';
import type { AnnotationProposal } from './annotation-proposal.ts';

import type { ChatTurn } from "./history.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed++;
}

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

const captured: Captured[] = [];

/** 一次 tool_use 的脚本:工具名与入参,原样发给模型侧。 */
interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** 假 API 这一轮的回复:要么提几个工具调用,要么收尾说一句话。 */
type Turn = { tools: ToolCall[] } | { text: string };

/** 按顺序消耗的脚本。用完之后一律回最后一条(收尾那句话)。 */
let script: Turn[] = [{ text: '收到。' }];

function sseText(text: string): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_stub","type":"message","role":"assistant","model":"stub","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
}

function sseTools(calls: ToolCall[]): string {
  const out: string[] = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_stub","type":"message","role":"assistant","model":"stub","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
  ];
  calls.forEach((call, index) => {
    out.push(
      'event: content_block_start',
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: `toolu_${index + 1}`, name: call.name, input: {} },
      })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
      })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index })}`,
      '',
    );
  });
  out.push(
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  );
  return out.join('\n');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => resolve(raw));
  });
}

let toolTurns = 0;

const stub = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const path = (req.url ?? '/').split('?')[0]!;
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = { _unparsed: raw.slice(0, 200) };
    }
    captured.push({ path, body });
    if (path.endsWith('/count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    /* 脚本只按 /v1/messages 推进:SDK 起手还会问一次 /api/hello,它不该吃掉
       一轮脚本(第一版就是这里差了一位:第一次模型调用拿到的是收尾那句)。 */
    if (!path.endsWith('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const turn = script[Math.min(toolTurns, script.length - 1)]!;
    toolTurns += 1;
    const payload = 'tools' in turn ? sseTools(turn.tools) : sseText(turn.text);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  })();
});

await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const stubPort = (stub.address() as AddressInfo).port;
const stubBase = `http://127.0.0.1:${stubPort}`;

const scratch = join(process.cwd(), '..', 'meta', 'proposal-check');
mkdirSync(scratch, { recursive: true });

/* CLI 子进程继承的是进程环境:把模型地址指到假 API 上,这一轮就不会打到真的
   那一侧(与 image-model-check.ts 同一路数)。 */
process.env.ANTHROPIC_BASE_URL = stubBase;
process.env.ANTHROPIC_API_KEY = 'proposal-check';
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

const config = loadConfig({
  ANTHROPIC_API_KEY: 'proposal-check',
  ANTHROPIC_BASE_URL: stubBase,
  MODEL: 'claude-opus-5',
  MAX_TURNS: '4',
  MAX_BUDGET_USD: '0.1',
  DAILY_BUDGET_USD: '0',
  SCRATCH_DIR: scratch,
  SEARCH_INDEX_URL: 'https://aipm.ac/search/search_index.json',
  TZ: 'UTC',
});

const index = WikiIndex.fromDocs([]);

/** 用户此刻在读的这一页。建议只能写给这一页 —— 模型参数里没有页面。 */
const selection: ContextItem = {
  kind: 'selection',
  page: '/ai/rag/',
  title: '检索增强生成',
  quote: '检索增强生成把外部知识接进上下文',
  prefix: '',
  suffix: '',
  body: '',
  color: '',
  chart: '',
  source: '',
  mediaType: '',
  imageData: '',
  visibility: 'public',
};

interface RunResult {
  proposals: AnnotationProposal[];
  calls: Record<string, unknown>[];
  answer: string;
}

/** 跑一轮:给定的脚本 + 语境,回收建议、模型收到的请求体与回答文本。 */
async function run(
  scriptTurns: Turn[], context: ContextItem[], page?: string | null, history: ChatTurn[] = [],
): Promise<RunResult> {
  script = scriptTurns;
  toolTurns = 0;
  captured.length = 0;
  const proposals: AnnotationProposal[] = [];
  const answer: string[] = [];
  await runAgent({
    message: '把这段里讲 RAG 的地方标一下',
    history,
    context,
    proposalPage: page,
    config,
    index,
    callbacks: {
      onDelta: (text) => answer.push(text),
      onThinking: () => {},
      onSources: () => {},
      onProposal: (proposal) => proposals.push(proposal),
    },
  });
  return {
    proposals,
    calls: captured.filter((c) => c.path.endsWith('/messages')).map((c) => c.body),
    answer: answer.join(''),
  };
}

const TOOL = 'mcp__wiki__propose_annotation';

/** 模型收到的请求里那些 tool_result 的内容。
 *
 * 两种形态都收:工具自己回的是一条文本结果(`content` 是一段文字),而 SDK 在
 * 入参不合 schema 时自己拦下的那条是 `MCP error -32602: …`(没有 is_error 字段,
 * 靠前缀认得出来)。 */
function toolResults(calls: Record<string, unknown>[]): { is_error: boolean; text: string }[] {
  const out: { is_error: boolean; text: string }[] = [];
  for (const body of calls) {
    const messages = body.messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages as { content?: unknown }[]) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type !== 'tool_result') continue;
        const content = block.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? (content as Record<string, unknown>[]).map((c) => String(c.text ?? '')).join('\n')
              : '';
        out.push({
          is_error: block.is_error === true || text.startsWith('MCP error'),
          text,
        });
      }
    }
  }
  return out;
}

/* ================================================================
   一、合规的一条:回调收到它,目标由请求页面确定
   ================================================================ */
const happy = await run(
  [
    {
      tools: [
        {
          name: TOOL,
          input: {
            scope: 'text',
            quote: '检索增强生成把外部知识接进上下文',
            color: 'blue',
            body: '这是本篇的核心定义',
            note: '建议标成结论色',
          },
        },
      ],
    },
    { text: '已在卡片里给你标出这一段。' },
  ],
  [selection],
);

check('合规的一条:恰好成型一条建议', happy.proposals.length === 1, `实际 ${happy.proposals.length} 条`);
const proposal = happy.proposals[0];
check('合规的一条:页面取自语境(模型没给、也给不了)', proposal?.page === '/ai/rag/', String(proposal?.page));
check('合规的一条:id 是本轮的序号 p1', proposal?.id === 'p1', String(proposal?.id));
check('合规的一条:引文逐字带过来', proposal?.quote === '检索增强生成把外部知识接进上下文', String(proposal?.quote));
check('合规的一条:颜色与正文照收', proposal?.color === 'blue' && proposal?.body === '这是本篇的核心定义');
check(
  '合规的一条:没写可见范围时缺省「仅本机」(三态里唯一不出网的)',
  proposal?.visibility === 'local',
  String(proposal?.visibility),
);
check('合规的一条:粒度缺省是 text', proposal?.scope === 'text', String(proposal?.scope));

const results = toolResults(happy.calls);
check('合规的一条:模型确实收到了工具结果', results.length === 1, `实际 ${results.length} 条`);
check(
  '合规的一条:结果明说「还没有写入」',
  results[0] !== undefined && results[0].text.includes('还没有写入') && results[0].text.includes('仅本机'),
  results[0]?.text.slice(0, 80),
);
check('合规的一条:结果不是错误', results[0]?.is_error === false);

/* ================================================================
   二、越权:模型自己塞页面与作者
   ----------------------------------------------------------------
   工具的参数里没有 page,也没有任何作者字段 —— 目标页面由服务端根据请求确定,
   后者的归属由批注服务按令牌定,两处都不经过模型的手。模型硬塞这两个键时,
   参数在 schema 那一层就被丢掉了(到不了处理器),建议照常成型,目标页面仍是语境
   里那一页。所以这里量的**不是**一条错误消息,而是不变式:它点名的页面没有
   生效,而且结果里明说了这条写给哪一页 —— 模型因此不会以为卡片长在别处。
   ================================================================ */
const escalate = await run(
  [
    {
      tools: [
        {
          name: TOOL,
          input: {
            page: '/admin/secret/',
            author: 'huangyincan',
            visibility: 'public',
            quote: '检索增强生成把外部知识接进上下文',
          },
        },
      ],
    },
    { text: '好。' },
  ],
  [selection],
);

check('越权:多写的 page / author 没有把建议顶掉', escalate.proposals.length === 1, JSON.stringify(escalate.proposals));
check(
  '越权:目标页面是语境里那一页,不是模型点名的那个',
  escalate.proposals[0]?.page === '/ai/rag/' && !JSON.stringify(escalate.proposals[0]).includes('admin'),
  String(escalate.proposals[0]?.page),
);
const escalateResults = toolResults(escalate.calls);
check(
  '越权:结果里把目标页面告诉模型,它不能以为自己说的是算数的',
  escalateResults.length === 1 && !escalateResults[0]!.is_error && escalateResults[0]!.text.includes('说的是 /ai/rag/'),
  escalateResults[0]?.text.slice(0, 120),
);

/* ================================================================
   三、可见范围 / 粒度 / 引文:不合规的不成型
   ================================================================ */
const bogus = await run(
  [
    {
      tools: [
        { name: TOOL, input: { quote: '检索增强生成把外部知识接进上下文', visibility: 'admin' } },
        { name: TOOL, input: { scope: 'text', quote: '' } },
        { name: TOOL, input: { scope: 'page', quote: '检索增强生成把外部知识接进上下文' } },
        { name: TOOL, input: { scope: 'page', body: '' } },
      ],
    },
    { text: '好。' },
  ],
  [selection],
);

check('不合规的四条:一条都没有成型', bogus.proposals.length === 0, JSON.stringify(bogus.proposals));
const bogusResults = toolResults(bogus.calls);
check(
  '不合规的四条:四条都回了错误、一条建议都没漏出去',
  bogusResults.length === 4 && bogusResults.every((r) => r.is_error),
  JSON.stringify(bogusResults.map((r) => r.is_error)),
);
check(
  '不合规的四条:认不出的可见范围由 schema 拦下,并告诉模型可选值是哪三个',
  /Invalid option/.test(bogusResults[0]?.text ?? '') &&
    ['local', 'public', 'private'].every((v) => (bogusResults[0]?.text ?? '').includes(v)),
  bogusResults[0]?.text.slice(0, 100),
);
check(
  '不合规的四条:另外三条回的是给模型看的规则说明',
  bogusResults.slice(1).every((r) => /quote|正文|锚定/.test(r.text)),
  JSON.stringify(bogusResults.slice(1).map((r) => r.text.slice(0, 40))),
);

/* ================================================================
   四、没有页面及语境时拒绝建议
   ================================================================ */
const noContext = await run(
  [
    { tools: [{ name: TOOL, input: { quote: '检索增强生成把外部知识接进上下文' } }] },
    { text: '好。' },
  ],
  [],
);

check('没有语境:没有建议成型', noContext.proposals.length === 0);
const noContextResults = toolResults(noContext.calls);
check(
  '没有语境:模型拿到的是「先说清在读哪一页」',
  noContextResults.length === 1 && noContextResults[0]!.is_error && noContextResults[0]!.text.includes('没有可锚定的页面'),
  noContextResults[0]?.text.slice(0, 100),
);

/* ================================================================
   五、一轮提超上限:多出来的回错误,不静默丢掉
   ================================================================ */
const currentPage = await run(
  [
    { tools: [{ name: TOOL, input: { scope: "page", body: "建议为当前文章增加案例" } }] },
    { text: "请确认这条评论建议。" },
  ],
  [],
  "/ai/rag/",
);
check("当前页无附加语境时生成整页建议", currentPage.proposals[0]?.page === "/ai/rag/" && currentPage.proposals[0]?.scope === "page");
check("当前页地址进入模型输入", JSON.stringify(currentPage.calls[0]).includes("https://aipm.ac/ai/rag/"));

const changedPage = await run(
  [
    { tools: [{ name: TOOL, input: { scope: "page", body: "这篇文章可补充实践要点", page: "/ai/rag/" } }] },
    { text: "请确认。" },
  ],
  [],
  "/ai/prompting/",
  [{ role: "user", content: "原先阅读的页面是 /ai/rag/" }],
);
check("换页后模型参数不能覆盖目标", changedPage.proposals[0]?.page === "/ai/prompting/");
check("历史记录不能覆盖当前页面", JSON.stringify(changedPage.calls[0]).includes("原先阅读的页面是 /ai/rag/"));

const many: ToolCall[] = [];
for (let i = 0; i < PROPOSAL_MAX_ITEMS + 1; i++) {
  many.push({
    name: TOOL,
    input: { quote: `检索增强生成把外部知识接进上下文(${i + 1})`, visibility: 'local' },
  });
}
const overflow = await run([{ tools: many }, { text: '好。' }], [selection]);

check(
  `超上限:刚好成型 ${PROPOSAL_MAX_ITEMS} 条`,
  overflow.proposals.length === PROPOSAL_MAX_ITEMS,
  `实际 ${overflow.proposals.length} 条`,
);
check(
  '超上限:id 按先后排,没有重号',
  overflow.proposals.map((p) => p.id).join(',') ===
    Array.from({ length: PROPOSAL_MAX_ITEMS }, (_, i) => `p${i + 1}`).join(','),
  overflow.proposals.map((p) => p.id).join(','),
);
const overflowResults = toolResults(overflow.calls);
check(
  '超上限:多出来的那一条回了错误',
  overflowResults.length === PROPOSAL_MAX_ITEMS + 1 && overflowResults.filter((r) => r.is_error).length === 1,
  JSON.stringify(overflowResults.map((r) => r.is_error)),
);

/* ================================================================
   六、全页评论那条粒度
   ================================================================ */
const pageComment = await run(
  [
    {
      tools: [
        { name: TOOL, input: { scope: 'page', body: '这一页的结论建议补一个适用范围', visibility: 'private' } },
      ],
    },
    { text: '好。' },
  ],
  [selection],
);

check('全页评论:成型一条', pageComment.proposals.length === 1, JSON.stringify(pageComment.proposals));
check(
  '全页评论:没有引文,正文与可见范围照收',
  pageComment.proposals[0]?.scope === 'page' &&
    pageComment.proposals[0]?.quote === '' &&
    pageComment.proposals[0]?.visibility === 'private',
  JSON.stringify(pageComment.proposals[0]),
);

stub.close();

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
