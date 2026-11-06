/** 主题包校验失败：message 直接给人看，不把 JSON / 解压栈抛到界面上。 */
export class ThemeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ThemeError";
    this.code = code;
  }
}

export function themeErrorMessage(err: unknown): string {
  if (err instanceof ThemeError) return err.message;
  if (err instanceof Error) return err.message || "主题操作失败。";
  return String(err) || "主题操作失败。";
}
