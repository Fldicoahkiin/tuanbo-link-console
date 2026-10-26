import type { PreflightCheck } from './link-preflight';

export type PreflightLogEntry = { level: 'info' | 'error'; message: string; result: 'succeeded' | 'failed'; details?: Readonly<Record<string, unknown>> };

/**
 * One preflight run as run-log entries: a single summary carrying every result in its details, each blocking
 * check on its own line every time, and an advisory (warning status) once per project, check and wording in
 * this run of the software, since it repeats on every song until someone changes the project.
 */
export function preflightLogEntries(checks: readonly PreflightCheck[], seen: Set<string>, projectId: string): PreflightLogEntry[] {
  const blocking = checks.filter(check => check.status === 'blocking'), advisories = checks.filter(check => check.status === 'warning');
  const notes = [blocking.length ? `${blocking.length} 项未通过` : '', advisories.length ? `${advisories.length} 项提示` : ''].filter(Boolean);
  const summary: PreflightLogEntry = {
    level: blocking.length ? 'error' : 'info', result: blocking.length ? 'failed' : 'succeeded',
    message: blocking.length ? `开播前检查未通过（${notes.join('，')}，共 ${checks.length} 项）` : `开播前检查通过（${[`${checks.length} 项`, ...notes].join('，')}）`,
    details: { checks: checks.map(({ id, label, status, detail }) => ({ id, label, status, detail })) }
  };
  const entries = [summary, ...blocking.map((check): PreflightLogEntry => ({ level: 'error', result: 'failed', message: `${check.label}：${check.detail}` }))];
  for (const check of advisories) {
    const key = `${projectId}\n${check.id}\n${check.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ level: 'info', result: 'succeeded', message: `开播前检查提示：${check.label}：${check.detail}` });
  }
  return entries;
}

/** Warning the first time something that needs a person's attention is recorded in this run, info when it repeats. */
export function firstTimeWarning(seen: Set<string>, key: string): 'warning' | 'info' {
  if (seen.has(key)) return 'info';
  seen.add(key);
  return 'warning';
}
