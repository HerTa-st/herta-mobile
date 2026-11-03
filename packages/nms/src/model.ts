// @ts-nocheck —— 直接从 DSH NMS 的纯函数内核移植；先保持逐字一致，后续再补类型。
/**
 * NMS 的纯函数内核：切分 / 相似度 / 时间衰减 / 激活扩散 / 常驻层装配。
 *
 * 约束：**本文件不得 import 任何东西**（更不许 import \`@deepseek-ai/*\`）。
 * 它要能在 \`node --test\` 里裸跑，也要能被 store / tools / plugin 复用同一套规则。
 *
 * 设计对应 CONTEXT.md 的术语：
 *   · 有效权重 = 基础权重经过时间衰减（90 天半衰期）
 *   · 激活 = 相似度 × 有效权重 + 1 跳邻居加成（联想扩散，不是 top-k 相似度检索）
 *   · 常驻层 = 语义记忆 + 语气/关系笔记，固定预算内装配
 */

/** 90 天半衰期：两周忘掉约 10%，三个月忘掉一半。 */
export const DEFAULT_HALF_LIFE_DAYS = 90;
/** 1 跳邻居把激活传出去的折扣 —— 联想是次要信号，不能盖过自身相似度。 */
export const DEFAULT_SPREAD = 0.35;
/** CJK 每字约 0.6 token（估算用，与具体 tokenizer 无关）。 */
export const CJK_TOKEN_RATIO = 0.6;
/** 常驻层默认预算（token）。 */
export const DEFAULT_STATIC_BUDGET = 800;

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const ASCII_WORD_RE = /[A-Za-z0-9][A-Za-z0-9_'-]*/g;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 是否 CJK 字符。 */
export function isCjkChar(ch) {
  return CJK_RE.test(ch);
}

/**
 * 切分：中文取**相邻二字 bigram**，英文/数字取整词（小写）。
 *
 * 为什么是 bigram：中文没有空格，单字召回太散（「的」），整句又太严；
 * bigram 是不用词典也不引入 embedding 的最小可用单元。单字中文（如「梦」）
 * 保留为 unigram，否则一个字的查询永远匹配不到任何东西。
 *
 * @param {string} text
 * @returns {string[]} 去重前的 token 序列。
 */
export function tokenize(text) {
  const tokens = [];
  if (typeof text !== "string" || text.length === 0) return tokens;
  const chars = Array.from(text);
  let cjkRun = [];
  const flushCjk = () => {
    if (cjkRun.length === 1) tokens.push(cjkRun[0]);
    else for (let i = 0; i + 1 < cjkRun.length; i += 1) tokens.push(cjkRun[i] + cjkRun[i + 1]);
    cjkRun = [];
  };
  let ascii = null;
  const flushAscii = () => {
    if (ascii !== null) {
      tokens.push(ascii.toLowerCase());
      ascii = null;
    }
  };
  for (const ch of chars) {
    if (isCjkChar(ch)) {
      flushAscii();
      cjkRun.push(ch);
    } else if (/[A-Za-z0-9_'-]/.test(ch)) {
      flushCjk();
      ascii = (ascii ?? "") + ch;
    } else {
      flushCjk();
      flushAscii();
    }
  }
  flushCjk();
  flushAscii();
  return tokens;
}

/** 词频表。 */
export function termFreq(tokens) {
  const map = new Map();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

/**
 * 余弦相似度（term-frequency 空间）。
 * @param {string[]} aTokens
 * @param {string[]} bTokens
 * @returns {number} 0–1；任一为空时 0。
 */
export function similarity(aTokens, bTokens) {
  if (!Array.isArray(aTokens) || !Array.isArray(bTokens)) return 0;
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const fa = termFreq(aTokens);
  const fb = termFreq(bTokens);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [token, count] of fa) {
    na += count * count;
    const other = fb.get(token);
    if (other !== undefined) dot += count * other;
  }
  for (const count of fb.values()) nb += count * count;
  if (na === 0 || nb === 0) return 0;
  // 浮点误差可能让余弦略大于 1（例如 1.0000000000000002）—— 夹回 [0,1]，
  // 否则「同一文本相似度恰好为 1」这类断言与下游阈值判断都会被噪声咬。
  return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/**
 * 静态注入段的 token 估算（CJK 感知；与 estimateTokens 同一算法，独立命名便于测试与调用）。
 * @param {string} text
 * @returns {number}
 */
export function estimateStaticTokens(text) {
  return estimateTokens(String(text ?? ""));
}

/**
 * 把文本截断到不超过 budgetTokens（按 estimateStaticTokens 计）。
 *
 * CJK 与 ASCII 的 token 密度不同，不能按字符数一刀切；二分字符长度找到能放下的
 * 最长前缀，必要时补「…」。返回串保证 estimateStaticTokens(result) <= budget。
 *
 * @param {string} text
 * @param {number} budgetTokens
 * @returns {string}
 */
export function truncateToBudget(text, budgetTokens) {
  const source = String(text ?? "");
  const budget = Math.max(0, Math.floor(Number(budgetTokens) || 0));
  if (source.length === 0 || budget === 0) return "";
  if (estimateStaticTokens(source) <= budget) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateStaticTokens(source.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  if (low <= 0) return "";
  const kept = source.slice(0, low);
  const withEllipsis = kept + "…";
  return estimateStaticTokens(withEllipsis) <= budget ? withEllipsis : kept;
}

/** 解析 ISO 时间；拿不到返回 null。 */
export function parseTime(iso) {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 过了多少天（可为小数；负数按 0 处理）。 */
export function daysBetween(fromIso, now = Date.now()) {
  const from = parseTime(fromIso);
  if (from === null) return 0;
  return Math.max(0, (now - from) / DAY_MS);
}

/** 时间衰减因子：\`0.5 ** (days / halfLifeDays)\`。 */
export function decayFactor(elapsedDays, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return 1;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  return Math.pow(0.5, elapsedDays / halfLifeDays);
}

/**
 * 有效权重 = 基础权重 × 时间衰减（自 \`lastRecallAt\` 起算）。
 *
 * \`lastRecallAt\` 缺失表示「没被回忆过」—— 此时不做衰减，直接返回基础权重。
 * 结果夹到 [0, 1]（权重语义是概率式的强度，不放大）。
 *
 * @param {number} weight
 * @param {string|null|undefined} lastRecallAt - ISO 时间。
 * @param {number} [now] - 毫秒时间戳。
 * @param {number} [halfLifeDays]
 */
export function effectiveWeight(weight, lastRecallAt, now = Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const base = Number.isFinite(weight) ? weight : 0;
  if (lastRecallAt === null || lastRecallAt === undefined) return clamp01(base);
  const elapsed = daysBetween(lastRecallAt, now);
  return clamp01(base * decayFactor(elapsed, halfLifeDays));
}

/** token 估算：CJK 每字 0.6，其余每 4 字符 1，向上取整。 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkChar(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * CJK_TOKEN_RATIO + other / 4);
}

/** 标题归一化（去重比较用；不改存储值）。 */
export function normalizeTitle(title) {
  return String(title ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** 建邻接表：id → [{ other, strength }]（双向）。 */
export function buildAdjacency(edges) {
  const map = new Map();
  if (!Array.isArray(edges)) return map;
  for (const edge of edges) {
    if (!edge || !Number.isFinite(edge.a) || !Number.isFinite(edge.b)) continue;
    const strength = Number.isFinite(edge.strength) ? edge.strength : 0;
    if (!map.has(edge.a)) map.set(edge.a, []);
    if (!map.has(edge.b)) map.set(edge.b, []);
    map.get(edge.a).push({ other: edge.b, strength });
    map.get(edge.b).push({ other: edge.a, strength });
  }
  return map;
}

/** 节点自身可被检索的文本。 */
export function nodeText(node) {
  const parts = [node?.title, node?.gist, node?.body];
  return parts.filter((part) => typeof part === "string" && part.length > 0).join(" ");
}

/**
 * 一条记忆的激活量。
 *
 * \`activation = 相似度 × 有效权重 + Σ(边强度 × 邻居相似度 × 邻居有效权重 × spread)\`
 *
 * **没有 query 时**（\`queryTokens === null\`）相似度按 1 处理：没有线索的回忆
 * 就是「按强度想起」，而不是全 0。
 *
 * @param {object} node
 * @param {object} args
 * @param {string[]|null} args.queryTokens
 * @param {number} [args.now]
 * @param {number} [args.halfLifeDays]
 * @param {number} [args.spread]
 * @param {Map<number, object>} [args.byId] - 邻居解析用（含非候选节点）。
 * @param {Map<number, {other:number,strength:number}[]>} [args.adjacency]
 * @returns {{node:object, similarity:number, effectiveWeight:number, neighborBoost:number, activation:number, viaNeighbors:object[]}}
 */
export function activationForNode(node, args = {}) {
  const now = args.now ?? Date.now();
  const halfLifeDays = args.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const spread = args.spread ?? DEFAULT_SPREAD;
  const queryTokens = args.queryTokens ?? null;
  const eff = effectiveWeight(node?.weight, node?.lastRecallAt, now, halfLifeDays);
  const sim = queryTokens === null ? 1 : similarity(queryTokens, tokenize(nodeText(node)));

  let neighborBoost = 0;
  const viaNeighbors = [];
  if (queryTokens !== null && args.adjacency instanceof Map && args.byId instanceof Map) {
    const links = args.adjacency.get(node.id) ?? [];
    for (const link of links) {
      const neighbor = args.byId.get(link.other);
      if (!neighbor || neighbor.archived || neighbor.forgotten) continue;
      const neighborSim = similarity(queryTokens, tokenize(nodeText(neighbor)));
      if (neighborSim === 0) continue;
      const neighborEff = effectiveWeight(neighbor.weight, neighbor.lastRecallAt, now, halfLifeDays);
      const contribution = link.strength * neighborSim * neighborEff * spread;
      if (contribution <= 0) continue;
      neighborBoost += contribution;
      viaNeighbors.push({ id: neighbor.id, strength: round6(link.strength), contribution: round6(contribution) });
    }
    viaNeighbors.sort((a, b) => b.contribution - a.contribution);
  }

  return {
    node,
    similarity: round6(sim),
    effectiveWeight: round6(eff),
    neighborBoost: round6(neighborBoost),
    activation: round6(sim * eff + neighborBoost),
    viaNeighbors: viaNeighbors.slice(0, 5),
  };
}

/**
 * 排序候选：激活降序 → 有效权重降序 → id 升序（结果必须可重放）。
 *
 * @param {object} args
 * @param {object[]} args.nodes - 全部活动节点（含非候选，邻居要能解析到）。
 * @param {object[]} [args.edges]
 * @param {string} [args.query]
 * @param {"ep"|"sem"|"note"|null} [args.tier]
 * @param {number} [args.limit]
 * @param {number} [args.now]
 * @param {number} [args.halfLifeDays]
 * @param {number} [args.spread]
 */
export function rankCandidates(args = {}) {
  const nodes = Array.isArray(args.nodes) ? args.nodes : [];
  const limitRaw = args.limit ?? 5;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 5;
  const now = args.now ?? Date.now();
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const queryTokens = query.length === 0 ? null : tokenize(query);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(args.edges ?? []);
  const tier = args.tier ?? null;

  const scored = nodes
    .filter((node) => !node.archived && !node.forgotten)
    .filter((node) => (tier === null ? true : node.tier === tier))
    .map((node) =>
      activationForNode(node, {
        queryTokens,
        now,
        halfLifeDays: args.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
        spread: args.spread ?? DEFAULT_SPREAD,
        byId,
        adjacency,
      }),
    );

  scored.sort(
    (a, b) =>
      b.activation - a.activation ||
      b.effectiveWeight - a.effectiveWeight ||
      a.node.id - b.node.id,
  );

  return { candidates: scored.length, query, tier, results: scored.slice(0, limit) };
}

/** MMR 轻量版：近重复簇（标题 bigram 相似度）阈值。 */
export const MMR_CLUSTER_SIMILARITY = 0.6;
/** 近重复簇的第二种判据：标题共享多少个 token（bigram/词）。 */
export const MMR_MIN_SHARED_KEYWORDS = 2;

/** 标题 token 集合（去重；过滤单字，降低「的/了」噪声）。 */
function titleTokens(node) {
  const title = normalizeTitle(node?.title ?? "");
  if (title.length === 0) return [];
  return [...new Set(tokenize(title).filter((token) => token.length >= 2))];
}

/** 两条记忆是否属于「近重复簇」：标题 bigram 相似度 >= 阈值，或共享 token >= 阈值。 */
export function isNearDuplicateTitle(aNode, bNode, { clusterSimilarity = MMR_CLUSTER_SIMILARITY, minSharedKeywords = MMR_MIN_SHARED_KEYWORDS } = {}) {
  const aTokens = titleTokens(aNode);
  const bTokens = titleTokens(bNode);
  if (aTokens.length === 0 || bTokens.length === 0) return false;
  if (similarity(aTokens, bTokens) >= clusterSimilarity) return true;
  const bSet = new Set(bTokens);
  let shared = 0;
  for (const token of new Set(aTokens)) if (bSet.has(token)) shared += 1;
  return shared >= minSharedKeywords;
}

/**
 * 轻量 MMR：同一近重复簇最多保留 1 条；名额不够时按 activation×similarity 回填。
 *
 * 输入是 rankCandidates 的 results（已按激活排序，含 {node, activation, similarity, ...}）。
 * 不改 topK：调用方仍然按 limit 取。
 *
 * @param {Array<object>} items
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {number} [options.clusterSimilarity]
 * @param {number} [options.minSharedKeywords]
 * @returns {Array<object>} 选择后的 items（保持排序语义）
 */
export function diversifyCandidates(items, options = {}) {
  const list = Array.isArray(items) ? items.filter((item) => item !== null && typeof item === "object") : [];
  const rawLimit = options.limit;
  const limit = rawLimit === undefined || rawLimit === null ? list.length : Math.max(0, Math.floor(Number(rawLimit) || 0));
  if (list.length <= 1 || limit <= 0) return list.slice(0, Math.max(0, limit));
  const clusterSimilarity = Number.isFinite(Number(options.clusterSimilarity)) ? Number(options.clusterSimilarity) : MMR_CLUSTER_SIMILARITY;
  const minSharedKeywords = Number.isFinite(Number(options.minSharedKeywords))
    ? Math.max(1, Math.floor(Number(options.minSharedKeywords)))
    : MMR_MIN_SHARED_KEYWORDS;
  const clusterOptions = { clusterSimilarity, minSharedKeywords };
  const kept = [];
  const skipped = [];
  for (const item of list) {
    if (kept.length >= limit) break;
    const near = kept.some((other) => isNearDuplicateTitle(other.node, item.node, clusterOptions));
    if (near) skipped.push(item);
    else kept.push(item);
  }
  // 注意：不回填近重复项 —— 「同一簇最多 1 条」是硬约束；候选不够就少返回。
  // 不同簇的候选由主循环继续按 activation 顺序填补（skipped 只装近重复）。
  return kept;
}

/**
 * 装配常驻层（语义记忆 + 语气笔记），预算内按有效权重降序取。
 *
 * 预算按**整段文本**算（含标题行），装不下就停 —— 先保证不超过 staticBudget。
 * 没有内容时返回 \`text: ''\`，DSH 的 renderPrompt 会丢掉空段，天然不占位。
 *
 * @param {object[]} nodes
 * @param {number} [budgetTokens]
 * @param {{now?:number, halfLifeDays?:number}} [options]
 * @returns {{text:string, tokens:number, included:{sem:number[], note:number[]}, budgetTokens:number}}
 */
export function assembleStaticSection(nodes, budgetTokens = DEFAULT_STATIC_BUDGET, options = {}) {
  const budget = Number.isFinite(budgetTokens) ? Math.max(0, Math.floor(budgetTokens)) : DEFAULT_STATIC_BUDGET;
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const active = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => !node.archived && !node.forgotten)
    .map((node) => ({
      node,
      eff: effectiveWeight(node.weight, node.lastRecallAt, now, halfLifeDays),
    }));

  const pick = (tier) =>
    active
      .filter((item) => item.node.tier === tier)
      .sort((a, b) => b.eff - a.eff || a.node.id - b.node.id);

  const sem = pick("sem");
  const note = pick("note");
  if (sem.length === 0 && note.length === 0) {
    return { text: "", tokens: 0, included: { sem: [], note: [] }, budgetTokens: budget };
  }

  const lines = ["## 神经记忆 · 常驻层"];
  const included = { sem: [], note: [] };
  const sections = [
    { tier: "sem", title: "### 语义记忆", items: sem, bucket: included.sem },
    { tier: "note", title: "### 语气与关系", items: note, bucket: included.note },
  ];

  for (const section of sections) {
    if (section.items.length === 0) continue;
    const pendingTitle = section.title;
    const pendingLines = [];
    for (const item of section.items) {
      const line = '- ' + item.node.title + ' —— ' + item.node.gist;
      const candidate = [...lines, ...pendingLines, pendingTitle, line].join('\n');
      if (estimateTokens(candidate) > budget) break;
      pendingLines.push(line);
      section.bucket.push(item.node.id);
    }
    if (pendingLines.length > 0) {
      lines.push(pendingTitle, ...pendingLines);
    }
  }

  const text = included.sem.length === 0 && included.note.length === 0 ? "" : lines.join("\n");
  return { text, tokens: estimateTokens(text), included, budgetTokens: budget };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
