#!/usr/bin/env node
/**
 * 位图那条通路的动态回归:图像**确实到了模型那一侧**。
 *
 *   npm run image-check
 *
 * 这条通路的前半段(文件字节 → 语境条目 → 请求体)由浏览器用例证明;这里是后半段:
 * 请求体里的 base64 有没有变成模型 API 请求里的一条 image 内容块。
 *
 * 造法:起一个假的模型 API,把 ANTHROPIC_BASE_URL 指到它,然后**真跑一轮**
 * runAgent —— 真 SDK、真 CLI 子进程、真 HTTP 请求。假 API 把收到的请求体抄下来,
 * 用它自己那份 SSE 脚本把这一轮结束掉。于是断言的对象不是我们自己的中间变量,
 * 而是模型真正会收到的那个字节流。
 *
 * 不联网、不需要 ANTHROPIC_API_KEY(配置里塞的是假 key,索引是空的 WikiIndex):
 * 请求全打在回环上的假 API。
 *
 * 反证(去掉 mediaType / imageData 从 buildPromptInput 到内容块的那一步,或让
 * contextImages 返回空数组)时,下面每一条图像断言都会红。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { WikiIndex } from './search.ts';
import { IMAGE_UNSUPPORTED_MESSAGE, runAgent } from './agent.ts';
import type { ContextItem } from './context.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed++;
}

/* 一张 1×1 的 PNG。用真图而不是随手编的 base64:假 API 收到什么,这里就比什么。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 400 里那句上游报错带的请求编号。它属于**上游细节**,界面上一律不该出现 ——
    用例拿它当探针:出现了就说明上游原文漏到了用户眼前。 */
const REJECT_REQUEST_ID = 'req_01REJECTPROBE';

/** 一轮回话的 SSE 脚本:一句话就结束,agent 不必再要下一轮。 */
const SSE_REPLY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_stub","type":"message","role":"assistant","model":"stub","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收到这张图。"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

const captured: Captured[] = [];

/** 这一轮假 API 收不收图。收,就照 SSE 脚本正常结束;不收,回 400 —— 与真实 API
    在模型不支持图像时给的东西同一形态。 */
let rejectImages = false;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => resolve(raw));
  });
}

/** 请求体里的 image 内容块。 */
function imagesIn(body: Record<string, unknown>): unknown[] {
  const list = body.messages;
  if (!Array.isArray(list)) return [];
  const out: unknown[] = [];
  for (const message of list as { content?: unknown }[]) {
    if (Array.isArray(message.content)) {
      out.push(...(message.content as { type?: string }[]).filter((b) => b.type === 'image'));
    }
  }
  return out;
}

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
    /* 计数接口:有的客户端在发正文前先问一次 token 数。 */
    if (path.endsWith('/count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (rejectImages && imagesIn(body).length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `messages.0.content.1.image.source.base64: This model does not support image inputs. Request id ${REJECT_REQUEST_ID}`,
          },
        }),
      );
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(SSE_REPLY);
  })();
});

await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const stubPort = (stub.address() as AddressInfo).port;
const stubBase = `http://127.0.0.1:${stubPort}`;

const scratch = join(process.cwd(), '..', 'meta', 'image-model-check');
mkdirSync(scratch, { recursive: true });

/* CLI 子进程继承的是进程环境:把模型地址指到假 API 上,这一轮就不会打到真的
   那一侧。SDK 的 options.env 只覆盖它自己拼的那份,进程环境是它的底座。 */
process.env.ANTHROPIC_BASE_URL = stubBase;
process.env.ANTHROPIC_API_KEY = 'image-model-check';
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

const config = loadConfig({
  ANTHROPIC_API_KEY: 'image-model-check',
  ANTHROPIC_BASE_URL: stubBase,
  MODEL: 'claude-opus-5',
  MAX_TURNS: '2',
  MAX_BUDGET_USD: '0.1',
  DAILY_BUDGET_USD: '0',
  SCRATCH_DIR: scratch,
  SEARCH_INDEX_URL: 'https://aipm.ac/search/search_index.json',
  TZ: 'UTC',
});

const bitmap: ContextItem = {
  kind: 'chart',
  page: '/ai/rag/',
  title: '检索增强生成',
  quote: '',
  prefix: '',
  suffix: '',
  body: '',
  color: '',
  chart: 'image',
  source: '页面上的第 1 张图(位图, 作者没有写替代文字)。',
  mediaType: 'image/png',
  imageData: PNG_BASE64,
  visibility: 'public',
};

const index = WikiIndex.fromDocs([]);

const answer: string[] = [];
const outcome = await runAgent({
  message: '这张图里画的是什么?',
  history: [],
  context: [bitmap],
  config,
  index,
  callbacks: {
    onDelta: (text) => answer.push(text),
    onThinking: () => {},
    onSources: () => {},
    onStderr: (line) => console.log(`[sdk] ${line.slice(0, 200)}`),
  },
});

const messages = captured.filter((c) => c.path.endsWith('/messages'));
check('假 API 收到了恰好一次模型调用', messages.length === 1, `实际 ${messages.length} 次:${captured.map((c) => c.path).join(', ')}`);
check('这一轮正常结束', outcome.ok, `${outcome.code ?? ''} ${outcome.message ?? ''}/ 回答:${answer.join('').slice(0, 40)}`);

const first = messages[0];
if (first === undefined) {
  console.log('\n没拿到模型请求,后面的断言无从谈起');
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}

/** 模型请求里的用户消息内容块。 */
const content = (() => {
  const list = first.body.messages;
  if (!Array.isArray(list) || list.length === 0) return null;
  const block = list[0] as { role?: string; content?: unknown };
  return Array.isArray(block.content) ? (block.content as Array<Record<string, unknown>>) : null;
})();

check('用户消息按内容块发出(不是一串纯文字)', content !== null, JSON.stringify(first.body.messages).slice(0, 120));

const images = (content ?? []).filter((b) => b.type === 'image');
check('模型请求里有 image 内容块', images.length === 1, `实际 ${images.length} 条`);
check(
  '图像是 base64 直传(不是地址)',
  images[0]?.source !== undefined &&
    (images[0]!.source as Record<string, unknown>).type === 'base64' &&
    (images[0]!.source as Record<string, unknown>).data === PNG_BASE64,
  JSON.stringify(images[0] ?? null).slice(0, 120),
);
check(
  '图像类型是 image/png',
  (images[0]?.source as Record<string, unknown> | undefined)?.media_type === 'image/png',
  String((images[0]?.source as Record<string, unknown> | undefined)?.media_type),
);

const texts = (content ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
check('同一轮里语境那段文字也在', texts.includes('用户正在读的一张图') && texts.includes('图像: 本消息附带的第 1 张图'), texts.slice(0, 80));
check('语境文字里说明了图像随本消息送来', texts.includes('位图(图像本身随本消息一起送过来)'));
check('最新那句问题压在最后', texts.trimEnd().endsWith('这张图里画的是什么?'));
check('模型侧看到的就是那段 base64,一字不差', JSON.stringify(first.body).includes(PNG_BASE64));

/* 对照:同样一条位图,不带图像内容时不该凭空多出一条 image 块 —— 证明上面那条
   不是「反正都会加」的假阳性。 */
captured.length = 0;
const textOnly: ContextItem = { ...bitmap, mediaType: '', imageData: '' };
const second = await runAgent({
  message: '这张图里画的是什么?',
  history: [],
  context: [textOnly],
  config,
  index,
  callbacks: { onDelta: () => {}, onThinking: () => {}, onSources: () => {} },
});
const control = captured.filter((c) => c.path.endsWith('/messages'))[0];
const controlBlocks = (() => {
  const list = control?.body.messages;
  if (!Array.isArray(list) || list.length === 0) return null;
  const block = list[0] as { content?: unknown };
  return Array.isArray(block.content) ? (block.content as Array<Record<string, unknown>>) : null;
})();
check('对照:不带图像的位图不发 image 块', (controlBlocks ?? []).filter((b) => b.type === 'image').length === 0 && (controlBlocks ?? []).length > 0);
check('对照:这一轮同样正常结束', second.ok, second.message ?? '');

/* ================================================================
   模型不收图:这一轮要能自己认出来,并给出一句可控的话
   ================================================================ */

/* 上游回 400 之后,CLI 自己会把图像块摘掉、重发一次 —— 那一轮因此**成功**结束,
   而回答根本没看过那张图。整条消息流里唯一能看出这件事的是 CLI 为此发的合成
   assistant 消息,下面这几条断言量的就是「我们认出了它,并且没有把上游原文
   端给用户」。 */
rejectImages = true;
captured.length = 0;
const rejectedAnswer: string[] = [];
const rejected = await runAgent({
  message: '这张图里画的是什么?',
  history: [],
  context: [bitmap],
  config,
  index,
  callbacks: {
    onDelta: (text) => rejectedAnswer.push(text),
    onThinking: () => {},
    onSources: () => {},
  },
});

const rejectedCalls = captured.filter((c) => c.path.endsWith('/messages'));
check('拒收的那一轮:第一次调用确实带着图', imagesIn(rejectedCalls[0]?.body ?? {}).length === 1, `调用 ${rejectedCalls.length} 次`);
check('拒收的那一轮:没有当成成功', !rejected.ok, `ok=${rejected.ok} numTurns=${rejected.numTurns}`);
check('拒收的那一轮:错误码是 image_unsupported', rejected.code === 'image_unsupported', String(rejected.code));
check(
  '拒收的那一轮:给用户的是一句能照着做的话',
  rejected.message === IMAGE_UNSUPPORTED_MESSAGE && rejected.message.includes('去掉'),
  String(rejected.message),
);
check(
  '拒收的那一轮:上游原文没有跟着这句话出去',
  !String(rejected.message).includes(REJECT_REQUEST_ID) &&
    !/does not support image inputs/i.test(String(rejected.message)),
  String(rejected.message),
);
check(
  '拒收的那一轮:没有把「假装看过图」的回答发出去',
  rejectedAnswer.join('') === '',
  JSON.stringify(rejectedAnswer),
);

stub.close();

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
