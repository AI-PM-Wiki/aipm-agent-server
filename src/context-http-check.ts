#!/usr/bin/env node
/**
 * /api/chat 的语境校验自检(要 npm 依赖,与零依赖的 src/unit-check.ts 分开):
 *
 *   npm run context-check
 *
 * 一个请求被收下就是真金白银的一轮模型调用,所以分两层,各证一半:
 *
 *  - **HTTP 一层证明拒得掉**:起真的 createApp、发真的 POST,断言坏请求停在
 *    400 + error=bad_request。schema 没挂上时这些请求不会停在 400 上。
 *  - **schema 一层证明收得下,并且拒的理由对**:HTTP 的 400 响应体只有一句固定
 *    的话,分不出坏在哪一处;直接 safeParse 才看得到是哪条规则报的,也才能断言
 *    好请求过得了 —— 好请求走 HTTP 会一路跑到模型去。
 *
 * 两层跑的是同一个 ChatBodySchema,所以「HTTP 拒掉的」与「schema 拒掉的」是同一
 * 组判断,不存在 HTTP 那层另有一套规则的可能。
 *
 * 不联网、不需要 ANTHROPIC_API_KEY(配置用假 key 走 loadConfig,索引用空的
 * WikiIndex.fromDocs):400 发生在任何模型调用之前。
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChatBodySchema, createApp } from './server.ts';
import { loadConfig } from './config.ts';
import { WikiIndex } from './search.ts';
import { CONTEXT_LIMITS, CONTEXT_MAX_ITEMS } from './context.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed++;
}

/** 一条合法的划选语境。各用例在它上面只改一处,好让失败指向那一条规则。 */
const selection = {
  kind: 'selection',
  page: '/ai/rag/',
  title: '检索增强生成',
  quote: '检索增强生成把外部知识接进上下文。',
  prefix: '简单说,',
  suffix: '它由两段组成。',
  body: '',
  color: '',
  chart: '',
  source: '',
  visibility: 'public',
};

/** 一条合法的批注语境。 */
const annotation = {
  ...selection,
  kind: 'annotation',
  quote: '召回率与精确率要一起看。',
  body: '这里的召回率是 top-k 口径。',
  color: 'blue',
  visibility: 'private',
};

/** 一条合法的图表语境。 */
const chart = {
  ...selection,
  kind: 'chart',
  quote: '',
  suffix: '',
  chart: 'mermaid',
  source: 'flowchart TB\n    source["源文档"] --> chunk["切块"]',
};

/** 一条带图像内容的位图语境(1×1 PNG 的开头)。 */
const bitmap = {
  ...chart,
  chart: 'image',
  source: '页面上的第 1 张图(位图, 作者没有写替代文本)。',
  mediaType: 'image/png',
  imageData: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
};

const chatBody = (context: unknown) => ({ message: '这段话是什么意思?', context });

/** 解析收下时返回 null,否则返回拒收的原因(多条用 / 连起来)。 */
function reasonOf(body: unknown): string | null {
  const res = ChatBodySchema.safeParse(body);
  if (res.success) return null;
  return res.error.issues.map((i) => i.message).join(' / ');
}

// ---- schema:收得下 ----
{
  check('schema: 划选与批注各一条 → 收下', reasonOf(chatBody([selection, annotation])) === null, reasonOf(chatBody([selection, annotation])) ?? '');

  const pageComment = { ...annotation, quote: '' };
  check('schema: 全页评论(批注只有正文) → 收下', reasonOf(chatBody([pageComment])) === null, reasonOf(chatBody([pageComment])) ?? '');

  const quoteOnly = { ...annotation, body: '' };
  check('schema: 只有原文的批注 → 收下', reasonOf(chatBody([quoteOnly])) === null, reasonOf(chatBody([quoteOnly])) ?? '');

  check('schema: 不带 context(老客户端) → 收下', reasonOf({ message: '你好' }) === null);

  check('schema: 图表(Mermaid 源码) → 收下', reasonOf(chatBody([chart])) === null, reasonOf(chatBody([chart])) ?? '');
  check('schema: 图表(SVG 与位图) → 收下', reasonOf(chatBody([{ ...chart, chart: 'svg' }, { ...chart, chart: 'image' }])) === null);

  check('schema: 位图带图像内容 → 收下', reasonOf(chatBody([bitmap])) === null, reasonOf(chatBody([bitmap])) ?? '');
  check('schema: 位图只带替代文本(取不到图像)→ 收下', reasonOf(chatBody([{ ...bitmap, mediaType: '', imageData: '' }])) === null);

  const wireBitmap = ChatBodySchema.safeParse(chatBody([bitmap]));
  check(
    'schema: 位图的类型与图像收下之后原样在',
    wireBitmap.success && wireBitmap.data.context[0]!.mediaType === 'image/png' && wireBitmap.data.context[0]!.imageData === bitmap.imageData,
  );

  const parsed = ChatBodySchema.safeParse({ message: '你好', context: [selection] });
  const wire = parsed.success ? parsed.data.context[0] : undefined;
  check('schema: 缺省值把可选字段补成空串', wire !== undefined && wire.prefix === '简单说,' && wire.body === '' && wire.color === '' && wire.chart === '' && wire.source === '' && wire.mediaType === '' && wire.imageData === '');

  const chartWire = ChatBodySchema.safeParse({ message: '你好', context: [chart] });
  check('schema: 图表收下之后种类与内容都在', chartWire.success && chartWire.data.context[0]!.chart === 'mermaid' && chartWire.data.context[0]!.source.startsWith('flowchart TB'));

  const two = ChatBodySchema.safeParse(chatBody([selection, { ...annotation, visibility: 'public' }]));
  check('schema: 多条按原顺序保留', two.success && two.data.context.length === 2 && two.data.context[1]!.kind === 'annotation');
}

// ---- schema:拒得掉,并且理由是那一条 ----
{
  const emptyQuote = { ...selection, quote: '   ' };
  check('schema: selection 的空原文被拒', /selection 语境必须有 quote/.test(reasonOf(chatBody([emptyQuote])) ?? ''), reasonOf(chatBody([emptyQuote])) ?? '');

  const emptyBoth = { ...annotation, quote: '', body: '  ' };
  check('schema: annotation 原文与正文都空被拒', /annotation 语境的 quote 与 body/.test(reasonOf(chatBody([emptyBoth])) ?? ''), reasonOf(chatBody([emptyBoth])) ?? '');

  const local = { ...selection, visibility: 'local' };
  check('schema: 仅本机(visibility: local)被拒', reasonOf(chatBody([local])) !== null, reasonOf(chatBody([local])) ?? '');

  const chartLocal = { ...chart, visibility: 'local' };
  check('schema: 仅本机的图表同样被拒', reasonOf(chatBody([chartLocal])) !== null, reasonOf(chatBody([chartLocal])) ?? '');

  const chartNoSource = { ...chart, source: '   ' };
  check('schema: 图表内容为空被拒', /chart 语境的 source 必须有内容/.test(reasonOf(chatBody([chartNoSource])) ?? ''), reasonOf(chatBody([chartNoSource])) ?? '');

  const chartNoKind = { ...chart, chart: '' };
  check('schema: 图表没有种类被拒', /chart 语境必须有 chart/.test(reasonOf(chatBody([chartNoKind])) ?? ''), reasonOf(chatBody([chartNoKind])) ?? '');

  const chartBadKind = { ...chart, chart: 'jpg' };
  check('schema: 图表种类不认识被拒', reasonOf(chatBody([chartBadKind])) !== null, reasonOf(chatBody([chartBadKind])) ?? '');

  const tooMany = Array.from({ length: CONTEXT_MAX_ITEMS + 1 }, () => selection);
  check(`schema: 超过 ${CONTEXT_MAX_ITEMS} 条被拒`, reasonOf(chatBody(tooMany)) !== null);

  const tooLong = { ...selection, quote: 'x'.repeat(CONTEXT_LIMITS.quote + 1) };
  check('schema: 超长原文被拒', reasonOf(chatBody([tooLong])) !== null);

  const chartTooLong = { ...chart, source: 'x'.repeat(CONTEXT_LIMITS.source + 1) };
  check('schema: 超长图表内容被拒', reasonOf(chatBody([chartTooLong])) !== null);

  /* 位图那份图像:成对、认得、尺寸之内。任何一条不过都拒 —— 收下去就是一条
     「图像本身也送过来了」的语境,而模型手里其实什么都没有。 */
  check('schema: 位图只给类型不给图像被拒', reasonOf(chatBody([{ ...bitmap, imageData: '' }])) !== null, reasonOf(chatBody([{ ...bitmap, imageData: '' }])) ?? '');
  check('schema: 位图只给图像不给类型被拒', reasonOf(chatBody([{ ...bitmap, mediaType: '' }])) !== null, reasonOf(chatBody([{ ...bitmap, mediaType: '' }])) ?? '');
  check('schema: 位图类型不在那四种里被拒', reasonOf(chatBody([{ ...bitmap, mediaType: 'image/tiff' }])) !== null);
  check('schema: Mermaid 图带图像被拒', reasonOf(chatBody([{ ...chart, mediaType: 'image/png', imageData: bitmap.imageData }])) !== null);
  check('schema: 超长图像内容被拒', reasonOf(chatBody([{ ...bitmap, imageData: 'A'.repeat(CONTEXT_LIMITS.imageData + 1) }])) !== null);

  check('schema: 空 page 被拒', reasonOf(chatBody([{ ...selection, page: '' }])) !== null);
  check('schema: 不认识的 kind 被拒', reasonOf(chatBody([{ ...selection, kind: 'comment' }])) !== null);
}

// ---- HTTP:同一组坏请求停在 400 ----
const config = loadConfig({ ANTHROPIC_API_KEY: 'context-check-only' });
const index = WikiIndex.fromDocs([], config.siteBase);
const { server } = createApp({ config, index });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const port = (server.address() as AddressInfo).port;

async function post(payload: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

const rejected: Array<[string, unknown]> = [
  ['selection 的空原文', chatBody([{ ...selection, quote: '   ' }])],
  ['annotation 原文与正文都空', chatBody([{ ...annotation, quote: '', body: '' }])],
  ['仅本机(visibility: local)', chatBody([{ ...selection, visibility: 'local' }])],
  ['仅本机的图表', chatBody([{ ...chart, visibility: 'local' }])],
  ['仅本机的位图(带图像内容)', chatBody([{ ...bitmap, visibility: 'local' }])],
  ['图表内容为空', chatBody([{ ...chart, source: '   ' }])],
  ['图表没有种类', chatBody([{ ...chart, chart: '' }])],
  ['图表种类不认识', chatBody([{ ...chart, chart: 'jpg' }])],
  ['位图只给类型不给图像', chatBody([{ ...bitmap, imageData: '' }])],
  ['位图只给图像不给类型', chatBody([{ ...bitmap, mediaType: '' }])],
  ['位图类型不认识', chatBody([{ ...bitmap, mediaType: 'image/tiff' }])],
  ['Mermaid 图带图像', chatBody([{ ...chart, mediaType: 'image/png', imageData: bitmap.imageData }])],
  [`超过 ${CONTEXT_MAX_ITEMS} 条`, chatBody(Array.from({ length: CONTEXT_MAX_ITEMS + 1 }, () => selection))],
  ['超长图像内容', chatBody([{ ...bitmap, imageData: 'A'.repeat(CONTEXT_LIMITS.imageData + 1) }])],
  ['空 page', chatBody([{ ...selection, page: '' }])],
  ['不认识的 kind', chatBody([{ ...selection, kind: 'comment' }])],
  ['请求体不是 JSON', '{'],
];

for (const [name, payload] of rejected) {
  const res = await post(payload);
  const isBadRequest = res.status === 400 && res.body.includes('"error":"bad_request"');
  check(`HTTP: ${name} → 400`, isBadRequest, `status=${res.status} body=${res.body.slice(0, 120)}`);
}

server.close();

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
