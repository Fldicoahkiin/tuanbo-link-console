const FAILED_PROJECT_KEY = 'tblink.failed-render-project-path.v1';

/** Keep the project file intact; only suspend automatic reopening after a renderer failure. */
export function suspendProjectReopen(path: string | null): void {
  if (path) localStorage.setItem(FAILED_PROJECT_KEY, path);
}
export function isProjectReopenSuspended(path: string): boolean {
  return localStorage.getItem(FAILED_PROJECT_KEY) === path;
}
export function allowProjectReopen(path: string): void {
  if (isProjectReopenSuspended(path)) localStorage.removeItem(FAILED_PROJECT_KEY);
}
