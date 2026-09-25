export function log(scope: string, message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope, message, ...extra }));
}
export function logError(scope: string, message: string, error: unknown, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), scope, message, error: error instanceof Error ? error.message : String(error), ...extra }));
}