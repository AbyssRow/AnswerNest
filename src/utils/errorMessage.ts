/**
 * 从任意抛出值中取出可读的错误文本。
 * Tauri 的 invoke 失败时抛出的是字符串（Rust 的 Err(String)），而不是 Error 对象，
 * 直接读 error.message 会得到 undefined。
 */
export function errorMessage(error: unknown, fallback = '未知错误'): string {
  if (typeof error === 'string') return error || fallback
  if (error instanceof Error) return error.message || fallback
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return fallback
}
