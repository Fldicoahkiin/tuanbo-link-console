#!/usr/bin/env node
// Waits for another job of this workflow run to finish and fails unless it passed. The release build runs beside
// the verify job and waits here just before it puts anything into the draft release, so a version whose checks fail
// never gets a draft, and its tag can still move to a fixed commit. Verify takes about a quarter of an hour and the
// build half an hour, so the wait is usually over at once.
//   node scripts/wait-for-job.mjs <job>        needs GITHUB_TOKEN and GITHUB_RUN_ID (both set in Actions)
import { pathToFileURL } from 'node:url';
import { github, REPOSITORY } from './github-releases.mjs';

const POLL_MS = 20_000;
const TIMEOUT_MS = 60 * 60_000;

/** Where the named job of a run stands. Re-running only the build lists the earlier attempt's verify job, which
 * stays valid; with several attempts listed, the latest counts. */
export function jobVerdict(jobs, name) {
  const matches = jobs.filter(job => job.name === name);
  if (matches.length === 0) return { done: false, ok: false, message: `还没看到 ${name} 作业` };
  const job = matches.reduce((latest, next) => ((next.run_attempt ?? 0) > (latest.run_attempt ?? 0) ? next : latest));
  if (job.status !== 'completed') return { done: false, ok: false, message: `${name} 作业还没结束（${job.status}）` };
  if (job.conclusion === 'success') return { done: true, ok: true, message: `${name} 作业已通过` };
  return { done: true, ok: false, message: `${name} 作业没有通过（${job.conclusion}），不放进草稿` };
}

export async function waitForJob(name, { listJobs, sleep, now = Date.now, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS, log = console.log }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const verdict = jobVerdict(await listJobs(), name);
    log(verdict.message);
    if (verdict.done) {
      if (!verdict.ok) throw new Error(verdict.message);
      return;
    }
    if (now() >= deadline) throw new Error(`等了 ${Math.round(timeoutMs / 60_000)} 分钟，${name} 作业还没结束`);
    await sleep(pollMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name] = process.argv.slice(2);
  const runId = process.env.GITHUB_RUN_ID;
  if (!name || !runId) {
    console.error('用法：node scripts/wait-for-job.mjs <作业名>（需要 GITHUB_TOKEN 和 GITHUB_RUN_ID）');
    process.exit(2);
  }
  try {
    await waitForJob(name, {
      listJobs: async () => (await github(`/repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`)).jobs,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
