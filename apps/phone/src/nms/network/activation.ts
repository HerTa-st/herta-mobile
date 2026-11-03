/**
 * 回忆点亮：激活事件 -> 每节点亮度。
 *
 * 桌面版由插件进程通过 SSE (/nms/api/events) 推事件，store 在模块层缓冲、
 * 去重、Tab 隐藏时补播。手机端没有宿主，召回与画布在同一个 JS 进程：
 * 调用方在 nms recall 之后直接 `store.ingest({seq, nodes:[{id, activation}]})`
 * 即可。这里保留桌面版的语义：
 *
 * - seq 去重（重连/重放不会亮两次），最近 128 个 seq；
 * - 每个事件按自身最大 activation 归一，种子最亮；
 * - 沿关联图最多 5 跳，每跳 ×0.3，只走强度 ≥ 0.6 的边；
 * - 亮度按 pulseMs / retainMs 两段衰减（collectActivationLevels）。
 *
 * 不再需要 SSE、可见性缓冲和 unread 角标；进程重启后事件自然清空。
 */

import type {
  NmsActivationEvent,
  NmsActivationEventRecord,
  NmsActivationLevelEvent,
  NmsActivationModel,
  NmsActivationNodeRef,
  NmsActivationSnapshot,
  NmsCanvasData,
  NmsCanvasNode,
  NmsNodeId,
} from "./types.ts";

export const ACTIVATION_DEFAULT_ENABLED = true;
export const ACTIVATION_DEFAULT_PULSE_MS = 2500;
export const ACTIVATION_DEFAULT_RETAIN_MS = 30000;
/** 脉冲结束时保留的亮度比例，之后在 retainMs 内淡到 0。 */
export const ACTIVATION_RETAIN_RATIO = 0.35;
/** 扩散上限与每跳衰减。 */
export const ACTIVATION_MAX_HOPS = 5;
export const ACTIVATION_HOP_FACTOR = 0.3;
/** 只有强关联（>= 0.6）才传导点亮。 */
export const ACTIVATION_MIN_EDGE = 0.6;
/** 低于这个亮度就当作没点亮，省掉一圈环和光晕。 */
export const ACTIVATION_MIN_LEVEL = 0.02;
/** 事件最多留 8 条；更老的没有显示价值。 */
export const ACTIVATION_EVENT_LIMIT = 8;
const ACTIVATION_SEQ_LIMIT = 128;
const ACTIVATION_PULSE_MIN_MS = 300;
const ACTIVATION_PULSE_MAX_MS = 20000;
const ACTIVATION_RETAIN_MAX_MS = 300000;
const ACTIVATION_PRUNE_SLACK_MS = 5000;

export interface NmsActivationStoreSettings {
  enabled?: boolean;
  pulseMs?: number;
  retainMs?: number;
}

export interface NmsActivationStore {
  subscribe(listener: () => void): () => void;
  /** 注意：每次调用返回新对象，不要直接丢给 useSyncExternalStore。 */
  getSnapshot(): NmsActivationSnapshot;
  /** 同进程 ingest；形状不对的事件静默丢弃。 */
  ingest(raw: unknown): void;
  setSettings(next?: NmsActivationStoreSettings | null): void;
  clear(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampSetting(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/**
 * 创建一个进程内激活 store。App 里应该只建一个（和 useNms 同层），
 * 这样画布外的召回逻辑也能 ingest，网络视图只负责订阅。
 */
export function createActivationStore(
  initial: NmsActivationStoreSettings = {},
): NmsActivationStore {
  const state = {
    version: 0,
    enabled: initial.enabled !== false,
    pulseMs: clampSetting(initial.pulseMs, ACTIVATION_DEFAULT_PULSE_MS, ACTIVATION_PULSE_MIN_MS, ACTIVATION_PULSE_MAX_MS),
    retainMs: clampSetting(initial.retainMs, ACTIVATION_DEFAULT_RETAIN_MS, 0, ACTIVATION_RETAIN_MAX_MS),
    events: [] as NmsActivationEventRecord[],
  };
  const listeners = new Set<() => void>();
  const seenSeq = new Set<string>();
  const seenOrder: string[] = [];

  function notify(): void {
    state.version += 1;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* 一个坏监听器不能把整条事件流打断 */
      }
    }
  }

  function rememberSeq(seq: unknown): boolean {
    if (seq === null || seq === undefined) return true;
    const key = String(seq);
    if (seenSeq.has(key)) return false;
    seenSeq.add(key);
    seenOrder.push(key);
    if (seenOrder.length > ACTIVATION_SEQ_LIMIT) {
      const dropped = seenOrder.shift();
      if (dropped !== undefined) seenSeq.delete(dropped);
    }
    return true;
  }

  function prune(now: number): void {
    const horizon = now - state.pulseMs - state.retainMs - ACTIVATION_PRUNE_SLACK_MS;
    state.events = state.events.filter((event) => event.receivedAtMs >= horizon).slice(-ACTIVATION_EVENT_LIMIT);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      prune(Date.now());
      return {
        version: state.version,
        enabled: state.enabled,
        pulseMs: state.pulseMs,
        retainMs: state.retainMs,
        events: state.events.slice(),
      };
    },
    ingest(raw) {
      if (!raw || typeof raw !== "object") return;
      const event = raw as Partial<NmsActivationEvent>;
      if (!rememberSeq(event.seq ?? null)) return;
      if (!state.enabled) return;
      const rowsRaw: unknown[] = Array.isArray(event.nodes) ? event.nodes : [];
      const rows: NmsActivationNodeRef[] = [];
      for (const row of rowsRaw) {
        if (!row || typeof row !== "object") continue;
        const candidate = row as { id?: unknown; activation?: unknown };
        if (typeof candidate.id !== "string" && typeof candidate.id !== "number") continue;
        const activation = Number(candidate.activation);
        if (!Number.isFinite(activation)) continue;
        const id: NmsNodeId = candidate.id;
        rows.push({ id, activation });
      }
      if (rows.length === 0) return;
      state.events.push({
        seq: event.seq ?? null,
        at: typeof event.at === "string" ? event.at : undefined,
        query: typeof event.query === "string" ? event.query : "",
        nodes: rows,
        receivedAtMs: Date.now(),
      });
      if (state.events.length > ACTIVATION_EVENT_LIMIT) {
        state.events = state.events.slice(-ACTIVATION_EVENT_LIMIT);
      }
      notify();
    },
    setSettings(next) {
      const enabled = next && typeof next.enabled === "boolean" ? next.enabled : state.enabled;
      const pulseMs =
        next && typeof next.pulseMs === "number" && Number.isFinite(next.pulseMs)
          ? clamp(next.pulseMs, ACTIVATION_PULSE_MIN_MS, ACTIVATION_PULSE_MAX_MS)
          : state.pulseMs;
      const retainMs =
        next && typeof next.retainMs === "number" && Number.isFinite(next.retainMs)
          ? clamp(next.retainMs, 0, ACTIVATION_RETAIN_MAX_MS)
          : state.retainMs;
      const changed = enabled !== state.enabled || pulseMs !== state.pulseMs || retainMs !== state.retainMs;
      state.enabled = enabled;
      state.pulseMs = pulseMs;
      state.retainMs = retainMs;
      if (!enabled) state.events = [];
      if (changed) notify();
    },
    clear() {
      if (state.events.length === 0) return;
      state.events = [];
      notify();
    },
  };
}

/**
 * 把激活快照 + 当前画布图编译成「每事件已扩散的亮度表」。
 * 每次 ingest 只算一次；画布每帧只做 max-over-events 的时间衰减。
 */
export function buildActivationModel(
  snapshot: NmsActivationSnapshot | null | undefined,
  data: NmsCanvasData,
): NmsActivationModel {
  const model: NmsActivationModel = {
    version: snapshot ? snapshot.version : 0,
    enabled: snapshot ? snapshot.enabled === true : false,
    pulseMs: snapshot ? snapshot.pulseMs : ACTIVATION_DEFAULT_PULSE_MS,
    retainMs: snapshot ? snapshot.retainMs : ACTIVATION_DEFAULT_RETAIN_MS,
    events: [],
  };
  if (!model.enabled || !snapshot || snapshot.events.length === 0 || data.nodes.length === 0) {
    return model;
  }

  const byRawId = new Map<string, NmsCanvasNode>();
  const byKey = new Map<string, NmsCanvasNode>();
  for (const node of data.nodes) {
    byKey.set(node.key, node);
    if (node.rawId !== null && node.rawId !== undefined) byRawId.set(String(node.rawId), node);
  }

  // 无向边的强度表，键是排好序的一对画布索引。
  const strengthByPair = new Map<string, number>();
  for (const edge of data.edges) {
    const low = Math.min(edge.a, edge.b);
    const high = Math.max(edge.a, edge.b);
    strengthByPair.set(low + ":" + high, edge.s);
  }

  for (const event of snapshot.events) {
    const seeds: Array<{ node: NmsCanvasNode; activation: number }> = [];
    let maxActivation = 0;
    for (const row of event.nodes) {
      const node = byRawId.get(String(row.id)) ?? byKey.get(String(row.id));
      if (!node) continue;
      const activation = clamp(Number(row.activation), 0, 1);
      if (activation > maxActivation) maxActivation = activation;
      seeds.push({ node, activation });
    }
    if (seeds.length === 0) continue;

    const levels = new Map<string, number>();
    const queue: Array<{ node: NmsCanvasNode; strength: number; hop: number }> = [];
    for (const seed of seeds) {
      // 按事件自身最大值归一：最亮的那条永远是 1，扩散邻居按 0.3^hop 递减。
      const strength = maxActivation > 0 ? clamp(seed.activation / maxActivation, 0.3, 1) : 0.6;
      if (strength > (levels.get(seed.node.key) ?? 0)) {
        levels.set(seed.node.key, strength);
        queue.push({ node: seed.node, strength, hop: 0 });
      }
    }

    let cursor = 0;
    while (cursor < queue.length) {
      const item = queue[cursor];
      cursor += 1;
      if (item.hop >= ACTIVATION_MAX_HOPS) continue;
      const next = item.strength * ACTIVATION_HOP_FACTOR;
      if (next < ACTIVATION_MIN_LEVEL) continue;
      for (const neighborId of item.node.links) {
        const neighbor = data.nodes[neighborId];
        if (!neighbor) continue;
        const low = Math.min(item.node.id, neighborId);
        const high = Math.max(item.node.id, neighborId);
        const edgeStrength = strengthByPair.get(low + ":" + high) ?? 0;
        if (edgeStrength < ACTIVATION_MIN_EDGE) continue;
        if (next > (levels.get(neighbor.key) ?? 0)) {
          levels.set(neighbor.key, next);
          queue.push({ node: neighbor, strength: next, hop: item.hop + 1 });
        }
      }
    }

    if (levels.size > 0) {
      const parsed = event.at ? Date.parse(event.at) : Number.NaN;
      const atMs = Number.isFinite(event.receivedAtMs)
        ? event.receivedAtMs
        : Number.isFinite(parsed)
          ? parsed
          : Date.now();
      const record: NmsActivationLevelEvent = { atMs, levels };
      model.events.push(record);
    }
  }
  return model;
}

/** 当前时刻每节点亮度；没有点亮的节点不在 Map 里。 */
export function collectActivationLevels(
  model: NmsActivationModel | null | undefined,
  now: number,
): Map<string, number> {
  const levels = new Map<string, number>();
  if (!model || !model.enabled || model.events.length === 0) return levels;
  const pulseMs = model.pulseMs > 0 ? model.pulseMs : ACTIVATION_DEFAULT_PULSE_MS;
  const retainMs = Math.max(0, model.retainMs);
  for (const event of model.events) {
    let age = now - event.atMs;
    if (age < 0) age = 0;
    let factor: number;
    if (age <= pulseMs) {
      factor = 1 - (1 - ACTIVATION_RETAIN_RATIO) * (age / pulseMs);
    } else if (retainMs > 0 && age <= pulseMs + retainMs) {
      factor = ACTIVATION_RETAIN_RATIO * (1 - (age - pulseMs) / retainMs);
    } else {
      continue;
    }
    event.levels.forEach((strength, key) => {
      const value = strength * factor;
      if (value > (levels.get(key) ?? 0)) levels.set(key, value);
    });
  }
  return levels;
}

/** 画布是否还需要为衰减继续重绘（脉冲期间 30fps，结束后补一帧）。 */
export function hasActiveActivation(
  model: NmsActivationModel | null | undefined,
  now: number,
): boolean {
  if (!model || !model.enabled || model.events.length === 0) return false;
  const windowMs = model.pulseMs + model.retainMs + 50;
  for (const event of model.events) {
    if (now - event.atMs <= windowMs) return true;
  }
  return false;
}
