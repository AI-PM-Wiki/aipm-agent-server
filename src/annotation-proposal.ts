/**
 * Agent 提出的批注建议(AIPM#107 的「Agent 写批注」那一步)。
 *
 * 一条建议描述的是「我想写下这样一条批注」,不是一次写入。**模型手里没有凭据,
 * 也不该有**:建议随 SSE 交给页面,由用户在卡片上确认之后,才由**用户自己的会话**
 * 走既有的写入通路写进批注服务(公开/私有带用户的 bearer token POST 过去;仅本机
 * 只写 localStorage,一个字节都不出本机)。于是服务端那套归属、可见性与权限判断
 * 原样生效,模型输出能到达的最远处正好是「用户点一下鼠标」能到达的地方。
 *
 * 页面由客户端在每轮请求中提供，服务端按站内索引核对；显式语境须与页面一致。
 * 工具参数不含页面，模型无法修改建议的目标。
 *
 * 可见范围缺省 `local`:三态里只有它不出网。模型要提公开或私有的建议,得自己写明,
 * 而用户在卡片上还能改 —— 出不出本机这一档由用户点下去的那一刻定。
 *
 * 本文件刻意零依赖(与 context.ts / history.ts 同一路数):规则是纯函数,
 * `node src/unit-check.ts` 不需要 npm 包就能直接跑断言。工具入参的 zod schema
 * 在 tools.ts,取值与上限都取自这里的常量。
 */

import type { WikiIndex } from "./search.ts";

/** 一轮回话里最多提几条。超出的部分由工具回一句错误让模型收敛,不静默丢掉。 */
export const PROPOSAL_MAX_ITEMS = 4;

/** 色板 id:与前端 annotation-store.js 的 PALETTE 同一组取值(主仓库的约定测试
    核对两边一致)。 */
export const PROPOSAL_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;
export type ProposalColor = (typeof PROPOSAL_COLORS)[number];

/** 画法:与 annotation-store.js 的 ANNO_STYLES 同一组取值。 */
export const PROPOSAL_STYLES = ['underline', 'highlight', 'both'] as const;
export type ProposalStyle = (typeof PROPOSAL_STYLES)[number];

/** 可见范围。三态齐全 —— 与语境那条路不同:语境进的是模型上下文,「仅本机」在
    那道边界外;建议只是提案,「仅本机」是它的缺省值。 */
export const PROPOSAL_VISIBILITIES = ['local', 'public', 'private'] as const;
export type ProposalVisibility = (typeof PROPOSAL_VISIBILITIES)[number];

/** 锚定粒度:`text` = 划一段原文(可带正文,纯高亮就是空正文);
    `page` = 全页评论(不锚定任何一段文字,必须有正文)。 */
export const PROPOSAL_SCOPES = ['text', 'page'] as const;
export type ProposalScope = (typeof PROPOSAL_SCOPES)[number];

/** 各字段的字符上限。quote / edge 与语境的同名上限同值 —— 它们是同一段原文在两条
    通路上的长度,两边对「多长算超限」必须给出同一个答案。 */
export const PROPOSAL_LIMITS = {
  quote: 4000,
  edge: 200,
  body: 4000,
  note: 300,
} as const;

export interface AnnotationProposal {
  /** 这一轮里的序号,`p1` 起。卡片按它认人,重复采纳同一条不会写两遍。 */
  id: string;
  /** 本轮已核对的站内页面路径。 */
  page: string;
  scope: ProposalScope;
  /** 逐字引文(exact)。`text` 粒度必须有,`page` 粒度必须空。 */
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  color: ProposalColor;
  style: ProposalStyle;
  visibility: ProposalVisibility;
  /** 给用户看的一句理由。 */
  note: string;
}

/** 站内路径归一到「前导斜杠 + 尾斜杠」,与前端 panel 的 pagePath() 同一形态 ——
    两边不归一的话,卡片拿到手与当前页一比就会不相等,建议永远采纳不了。 */
export function normalizePage(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return '';
  const withLead = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

/**
 * 内部调用沿用显式语境；HTTP 请求由 resolveRequestPage 校验页面。
 */
export function proposalPage(
  items: readonly { page: string }[],
): string | null {
  for (const item of items) {
    const page = normalizePage(item.page);
    if (page.length > 0) return page;
  }
  return null;
}

export const INDEX_UNAVAILABLE = Symbol('index_unavailable');

/** undefined 表示页面无效；null 表示请求没有页面或语境。 */
export function resolveRequestPage(
  page: string | undefined,
  items: readonly { page: string }[],
  index: WikiIndex,
  siteBase: string,
): string | null | undefined | typeof INDEX_UNAVAILABLE {
  const target = page ?? items[0]?.page;
  if (target === undefined) return null;
  if (
    target.length > 512 || !target.startsWith("/") ||
    !target.endsWith("/") || target.includes("//") ||
    target.includes("\\") || target.includes("?") || target.includes("#") ||
    new URL(target, siteBase).pathname !== target ||
    items.some((item) => item.page !== target)
  ) return undefined;

  if (index.getStats().docCount === 0) return INDEX_UNAVAILABLE;
  const resolved = index.resolvePage(target);
  if (resolved === null || new URL(resolved.url).pathname !== target) return undefined;
  return target;
}

/**
 * 这条建议本身站不站得住:返回 null 表示收得下,否则返回一句给模型看的原因。
 *
 * 管的是**跨字段**那条规则(与语境那边的 contextItemProblem 同一路数):粒度决定
 * 哪几个字段必须有内容。`text` 要求逐字引文 —— 没有引文就没有可锚的点,页面既
 * 不知道高亮哪儿,也没有任何东西可以画在正文里。`page` 要求正文 —— 全页评论不锚
 * 文字,再没有正文就什么都不剩了。
 *
 * 字段的类型与长度由 tools.ts 的 schema 管。
 */
export function proposalProblem(proposal: {
  scope: ProposalScope;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
}): string | null {
  const quote = proposal.quote.trim();
  const body = proposal.body.trim();
  if (proposal.scope === 'page') {
    if (quote.length > 0 || proposal.prefix.length > 0 || proposal.suffix.length > 0) {
      return 'page 粒度的建议不锚定任何一段文字,quote / prefix / suffix 都要留空';
    }
    return body.length > 0 ? null : 'page 粒度的建议必须有正文(全页评论没有正文就什么都不剩)';
  }
  if (quote.length === 0) {
    return 'text 粒度的建议必须有 quote(要划的那段原文,逐字照抄)';
  }
  return null;
}

/** 可见范围在三态之外的取值 —— 由 schema 挡下,这里是最后一道。 */
export function isProposalVisibility(value: string): value is ProposalVisibility {
  return (PROPOSAL_VISIBILITIES as readonly string[]).includes(value);
}

/** 三态的中文说法:回给模型的那段结果、以及卡片上的标签共用一份。 */
export const PROPOSAL_VISIBILITY_LABEL: Record<ProposalVisibility, string> = {
  local: '仅本机',
  public: '公开',
  private: '仅自己可见',
};

/**
 * 工具回给模型的那段话。**必须说清楚还没写下去** —— 模型很容易把「工具返回成功」
 * 当成「已经写好了」,接着在回答里告诉用户「已为你高亮」。写入要等用户点采纳,
 * 这件事只有这段结果能告诉它。
 */
export function renderProposalResult(proposal: AnnotationProposal): string {
  const what =
    proposal.scope === 'page'
      ? '全页评论'
      : `引文「${proposal.quote.slice(0, 60)}${proposal.quote.length > 60 ? '…' : ''}」`;
  return [
    `已交给用户确认:${what},可见范围 ${PROPOSAL_VISIBILITY_LABEL[proposal.visibility]}` +
      `${proposal.body ? `,正文 ${proposal.body.length} 字` : ''}。`,
    /* 写向哪一页也写进结果:页面不是模型给的(参数里没有这一项),而它很容易以为是自己说的
       那一页。说了它才知道这张卡长在哪一页上。 */
    `这条建议说的是 ${proposal.page}(用户此刻在读的这一页);别处的内容只能用文字回答。`,
    '这条批注**还没有写入**。用户会在对话里看到一张建议卡,由他决定采纳或丢弃;' +
      '采纳之前不要说已经写好、也不要说已经高亮。',
    '不要重复提交同一条建议。',
  ].join('\n');
}
