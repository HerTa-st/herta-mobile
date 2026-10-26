/**
 * 废案的格式修复。
 *
 * 格式是死规矩（首行 `### 废案_NN：标题`、正文与对白之间一根 `---`），
 * 但它也是**唯一能被机器确定性地修**的部分。语气不合格要她重写，
 * 格式不合格不该——那是白烧一次调用、甚至白白丢掉一段记忆。
 *
 * 这里只动首行与分隔线，一个字的正文都不碰。
 */

const HEADER_ANY = /^#{0,6}\s*废案/;

export interface RepairResult {
  text: string;
  changed: boolean;
  reason: string | null;
}

function titleFromFirstLine(line: string, fallback: string): string {
  const stripped = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^废案(_\d+)?\s*[：:、.\-—]?\s*/, "")
    .trim();
  return (stripped || fallback).slice(0, 40);
}

export function repairFeian(text: string, index: number, fallbackTitle: string): RepairResult {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  const canonical = `### 废案_${String(index).padStart(2, "0")}：`;

  let changed = false;
  let reason: string | null = null;

  if (firstIdx < 0) {
    return { text, changed: false, reason: null };
  }

  const first = lines[firstIdx].trim();

  if (!HEADER_ANY.test(first)) {
    // 压根没有头部：补一个，正文原样跟在后面
    lines.splice(firstIdx, 0, canonical + fallbackTitle, "");
    changed = true;
    reason = "补了首行";
  } else if (!/^###\s*废案(_\d+)?[：:]\s*\S/.test(first)) {
    // 有头部但没守格式（少井号、用了半角冒号、没标题……）
    const title = titleFromFirstLine(first, fallbackTitle);
    lines[firstIdx] = canonical + title;
    changed = true;
    reason = "改了首行";
  }

  let body = lines.join("\n");
  if (!/^\s*---\s*$/m.test(body)) {
    // 少了分隔线：要插在**首段之后**，不是紧贴首行之后——
    // 紧跟首行会把「背景段落」挤到分隔线下面去，那不是它的位置。
    const bodyLines = body.split("\n");
    const headerAt = bodyLines.findIndex((l) => l.trim().length > 0);
    let paraStart = bodyLines.findIndex((l, i) => i > headerAt && l.trim().length > 0);
    if (paraStart < 0) paraStart = bodyLines.length - 1;
    let paraEnd = bodyLines.findIndex((l, i) => i > paraStart && l.trim().length === 0);
    if (paraEnd < 0) paraEnd = bodyLines.length;
    bodyLines.splice(paraEnd, 0, "", "---");
    body = bodyLines.join("\n");
    changed = true;
    reason = (reason ? reason + "、" : "") + "补了分隔线";
  }

  return { text: body, changed, reason };
}
