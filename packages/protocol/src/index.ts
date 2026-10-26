/**
 * 三端（手机 / PC 网关 / 油猴脚本）共用的类型与消息。
 * 一条纪律：**协议只在这一处定义**。任何一端想加字段，先改这里再看别处能不能编译。
 */

export type Lang = "zh" | "en";

/* ---------------------------------------------------------------- 会话模型 */

export type BlockKind = "user" | "herta" | "system";

/** 桌面版只认这两个标签；导入时工具调用必须降采样成 system 块，不能自造标签。 */
export type SystemLabel = "系统" | "差分协处理器";

export interface UserBlock {
  kind: "user";
  text: string;
  at: string;
  /** 手机本地存的附件（base64 或 objectURL 引用）；导入时一律丢弃。 */
  attachments?: { mediaType: string; data: string; name?: string }[];
}

export interface HertaBlock {
  kind: "herta";
  /** thought 走"想"轨，speech 走"说"轨——这是她的人格语法，不许合并。 */
  surface: "speech" | "thought";
  text: string;
  at: string;
}

export interface SystemBlock {
  kind: "system";
  label: SystemLabel;
  body: string;
  digest?: string;
  at: string;
}

export type Block = UserBlock | HertaBlock | SystemBlock;

export type SessionOrigin = "phone" | "import" | "pc";

export interface Session {
  id: string;
  title: string;
  origin: SessionOrigin;
  createdAt: string;
  updatedAt: string;
  blocks: Block[];
}

/* -------------------------------------------------------------- 导入模型 */

/** 油猴脚本产出的中间格式。手机与网关都只认这一个形状。 */
export interface ImportBundle {
  format: "herta-import";
  version: 1;
  source: "deepseek-web";
  exportedAt: string;
  /** 采集端版本，用于脚本失效时区分"没数据"与"数据格式变了"。 */
  collector: { name: string; version: string };
  sessions: ImportedSession[];
}

export interface ImportedSession {
  /** 站点侧的会话 id；去重与增量都要靠它。 */
  id: string;
  title: string;
  startedAt: string;
  messages: ImportedMessage[];
}

export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  /** 站点侧不一定给时间；没有就留空，别拿导出时间冒充。 */
  at?: string;
}

/* ------------------------------------------------------------ 网关协议 v2 */

/** 手机 → PC。 */
export type GatewayRequest =
  | { type: "hello"; token: string; client: { name: string; version: string } }
  | { type: "call"; id: string; method: string; args: unknown[] }
  | { type: "ping" };

/** PC → 手机。事件走 `event`，方法返回值走 `result`。 */
export type GatewayMessage =
  | { type: "ready"; protocol: 2; pc: { name: string; version: string }; session: Session | null }
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string }
  | { type: "event"; name: string; payload: unknown };

/** 网关方法白名单。**加方法要先改这里**——手机端不该能调用列表之外的东西。 */
export const GATEWAY_METHODS = [
  "session.list",
  "session.open",
  "session.create",
  "turn.submit",
  "turn.interrupt",
  "turn.retract",
  "approval.resolve",
  "voice.speak",
] as const;

export type GatewayMethod = (typeof GATEWAY_METHODS)[number];
