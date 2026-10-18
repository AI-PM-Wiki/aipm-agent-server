import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

export type SystemPromptUpdate = 'in-history' | 'leading-only';

const TextBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const Content = z.union([z.string(), z.array(TextBlock)]);
const RequestBody = z.object({
  model: z.string(),
  system: Content,
  messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()),
}).passthrough();

const McpInstructions = z.union([z.strictObject({ wiki: z.string().min(1) }), z.strictObject({})]);
const MCP_HEADER = '# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n';
const MCP_REMOVAL = 'The following MCP servers have disconnected. Their instructions above no longer apply:';
const NUMBER = '[0-9]+(?:\\.[0-9]+)?';
const STATUS = '(?:<total_tokens>[0-9]+ tokens left</total_tokens>|USD budget: \\$' + NUMBER +
  '/\\$' + NUMBER + '; \\$' + NUMBER + ' remaining|Current budget: ' + NUMBER + ' USD)';
const STATUS_SEQUENCE = new RegExp('^' + STATUS + '(?:\\n\\n' + STATUS + ')*$');

/** 仅核验固定 SDK 模板；校验副本不参与出站正文构造。 */
function validateAnnouncements(texts: string[], current: string, prefix: string): boolean {
  const announcement = current || MCP_REMOVAL + '\nwiki';
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wrapped = new RegExp('(^|\\n\\n)' + literal('<system-reminder>\n' + announcement + '\n</system-reminder>') +
    '(?=$|\\n\\n)', 'g');
  const bare = new RegExp('(^|\\n\\n)' + literal(announcement) + '(?=$|\\n\\n)', 'g');
  const part = '(?:' + literal(announcement) + '|' + STATUS + ')';
  const complete = new RegExp('^(?:\\n\\n)*' + part + '(?:\\n\\n' + part + ')*(?:\\n\\n)*$');
  let matches = 0;
  for (const text of texts) {
    const supplement = text.startsWith(prefix) ? text.slice(prefix.length) : text;
    const mark = (_match: string, separator: string) => {
      matches++;
      return separator;
    };
    let unchecked = supplement.replace(wrapped, mark);
    if (/MCP/i.test(unchecked)) {
      if (!complete.test(unchecked)) throw new Error('mcp_instructions_snapshot_mismatch');
      unchecked = unchecked.replace(bare, mark);
    }
    if (/MCP|(?:^|\n)[ \t]*#|<\/?system-reminder\b/i.test(unchecked)) {
      throw new Error('mcp_instructions_snapshot_mismatch');
    }
  }
  return current !== '' && matches > 0;
}

/** 快照来自本轮 MCP 配置；历史中省略公告不改变当前有效说明。 */
export function completeHistorySystem(body: unknown, strategy: SystemPromptUpdate | undefined, productPrompt: string,
  mcpInstructions?: Readonly<Record<string, string>>): unknown {
  if (strategy !== 'in-history') return body;
  if (!productPrompt) throw new Error('product_system_prompt_required');
  const parsed = RequestBody.parse(body);
  const top = typeof parsed.system === 'string' ? [parsed.system] : parsed.system.map(block => block.text);
  if (!top.some(text => text === productPrompt)) throw new Error('product_system_prompt_mismatch');
  const snapshot = McpInstructions.parse(mcpInstructions);
  const blocks = Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, instructions]) => `## ${name}\n${instructions}`);
  const current = blocks.length ? MCP_HEADER + blocks.join('\n\n') : '';
  const latest = parsed.messages.map(message => message.role).lastIndexOf('system');
  const prefix = productPrompt + '\n\n';
  const messages = parsed.messages.map((message, index) => {
    if (message.role !== 'system') return message;
    const content = Content.parse(message.content);
    const texts = (typeof content === 'string' ? [content] : content.map(block => block.text))
      .filter(text => text !== productPrompt);
    if (index === latest && current && texts.some(text => text.includes(MCP_REMOVAL))) {
      throw new Error('mcp_instructions_removal_requires_reconciled_snapshot');
    }
    const hasCurrent = index === latest && validateAnnouncements(texts, current, prefix);
    const supplement = index === latest && current && !hasCurrent ? current : '';
    if (typeof content === 'string') {
      const original = content === productPrompt ? '' : content.startsWith(prefix) ? content.slice(prefix.length) : content;
      const bounded = supplement && original && !STATUS_SEQUENCE.test(original)
        ? '<system-reminder>\n' + supplement + '\n</system-reminder>' : supplement;
      return { ...message, content: [productPrompt, bounded, original].filter(Boolean).join('\n\n') };
    }
    const original = content[0]?.text === productPrompt ? content.slice(1) : content;
    return { ...message, content: [content[0]?.text === productPrompt ? content[0] : { type: 'text', text: productPrompt },
      ...(supplement ? [{ type: 'text', text: supplement }] : []), ...original] };
  });
  return { ...parsed, messages };
}

export interface SystemPromptAdapterOptions {
  upstream: string;
  apiKey: string;
  model: string;
  productPrompt: string;
  signal: AbortSignal;
  maxBodyBytes: number;
  mcpInstructions: () => Readonly<Record<string, string>>;
}

/** SDK 子进程的单轮本机适配入口，生命周期与 runAgent 一致。 */
export async function openSystemPromptAdapter(options: SystemPromptAdapterOptions) {
  const upstream = new URL(options.upstream);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname);
  if ((upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && loopback)) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('invalid_system_prompt_upstream');
  }
  options.signal.throwIfAborted();
  const key = randomBytes(32).toString('hex');
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const handle = async () => {
      if (req.method === 'HEAD' && req.url === '/api/hello') { res.writeHead(404); res.end(); return; }
      if (req.headers['x-api-key'] !== key) { res.writeHead(401); res.end(); return; }
      const url = new URL(req.url!, 'http://127.0.0.1');
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') { res.writeHead(404); res.end(); return; }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => { if (!res.writableEnded) abort(); };
      options.signal.addEventListener('abort', abort, { once: true });
      req.once('aborted', abort); res.once('close', closed);
      try {
        options.signal.throwIfAborted();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > options.maxBodyBytes) throw new Error('system_prompt_request_limit');
          chunks.push(Buffer.from(chunk));
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const body = RequestBody.parse(JSON.parse(text));
        if (body.model !== options.model) throw new Error('system_prompt_model_mismatch');
        const bytes = Buffer.from(JSON.stringify(completeHistorySystem(body, 'in-history', options.productPrompt, options.mcpInstructions())));
        if (bytes.length > options.maxBodyBytes) throw new Error('system_prompt_request_limit');
        const target = new URL(upstream);
        target.pathname = upstream.pathname.replace(/\/$/, '') + url.pathname;
        target.search = url.search;
        const headers = { ...req.headers, host: target.host, 'x-api-key': options.apiKey, 'content-length': String(bytes.length) };
        delete headers.authorization;
        delete headers['transfer-encoding'];
        delete headers.connection;
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const outgoing = send(target, { method: 'POST', headers, signal: controller.signal });
        let responseStream: IncomingMessage | undefined;
        outgoing.on('error', error => responseStream?.destroy(error));
        const response = once(outgoing, 'response');
        outgoing.end(bytes);
        const [incoming] = await response;
        responseStream = incoming;
        res.writeHead(incoming.statusCode!, incoming.headers);
        await pipeline(incoming, res);
      } finally {
        options.signal.removeEventListener('abort', abort);
        req.off('aborted', abort); res.off('close', closed);
        controller.abort();
      }
    };
    const task = handle().catch(() => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"system_prompt_adapter_failed"}'); }
      else res.destroy();
    });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('system_prompt_adapter_address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: key,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(pending);
    },
  };
}
