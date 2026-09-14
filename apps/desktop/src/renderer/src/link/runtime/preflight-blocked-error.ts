import type { PreflightReport } from '@tb/core/link';

export class PreflightBlockedError extends Error {
  constructor(report: PreflightReport) {
    super(report.checks.filter((check) => check.status === 'blocking')
      .map((check) => `${check.label}：${check.detail}`).join('\n'));
    this.name = 'PreflightBlockedError';
  }
}
