import type { ChatDelta } from "@herta/protocol";

/** 把一条流拼成整段正文。工具调用那些增量不算正文。 */
export async function collect(gen: AsyncGenerator<ChatDelta>): Promise<string> {
  let out = "";
  for await (const d of gen) if (d.type === "text") out += d.text;
  return out;
}
