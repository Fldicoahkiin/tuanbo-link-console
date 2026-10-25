import { linkActionSchema, linkInternalAudioCaptureSchema, linkManagedMediaExecutionPayloadSchema, type LicenseStatus } from '@tb/schema';
import { nativePlayerControlSchema } from '@tb/schema';

const publicCalls = new Set([
  'link:ma2-audition-control', 'link:ma2-play-cancel',
  'link:native-obs-status', 'link:native-obs-stop', 'link:native-obs-preload-cancel',
  'link:native-player-status',
  'link:beauty-stop', 'link:beauty-status',
  'link:log-record', 'link:log-query', 'link:log-export', 'link:log-open-folder', 'link:diagnostic-export', 'link:feedback-submit', 'link:feedback-save',
  'link:license-status', 'link:license-activate-code', 'link:license-refresh-online',
  'link:license-export-request', 'link:license-import', 'link:window-control', 'link:window-visible',
  'link:purchase-catalog', 'link:purchase-list', 'link:purchase-create', 'link:purchase-refresh', 'link:purchase-open-payment',
  'link:purchase-copy-code',
  'link:app-info', 'link:update-status', 'link:update-check', 'link:process-stop', 'link:obs-disconnect', 'link:ma2-network-disconnect',
  'link:obs-source-cancel', 'link:obs-live-close', 'link:ma2-read-cancel',
  'link:ma2-discovery-cancel', 'link:p1-import-cancel',
  // Protecting unsaved work never waits for a license: the save itself follows the save rule.
  'link:set-document-state', 'link:resolve-unsaved-changes', 'link:save-response'
]);

const workspaceSaveCalls = new Set(['link:save-project', 'link:write-recovery-copy', 'link:discard-recovery-copy',
  'link:project-document-worker', 'link:restart-project-document-worker']);

export function needsProductLicense(channel: string, value: unknown): boolean {
  if (publicCalls.has(channel)) return false;
  if (channel === 'link:native-player-control') {
    const control = nativePlayerControlSchema.parse(value);
    return control.kind !== 'stop' && control.kind !== 'pause' && control.kind !== 'stop-mtc';
  }
  if (channel === 'link:set-runtime-active') return value !== false;
  if (channel === 'link:obs-internal-audio') return linkInternalAudioCaptureSchema.parse(value).enabled;
  if (channel === 'link:obs-execute-managed-media') return linkManagedMediaExecutionPayloadSchema.parse(value).event.phase === 'start';
  if (channel === 'link:obs-execute') {
    const action = linkActionSchema.parse(value);
    return !(action.kind === 'obs.mediaAction' && (action.action === 'stop' || action.action === 'pause')
      || action.kind === 'obs.setInputMute' && action.muted
      || action.kind === 'obs.setSceneItemEnabled' && !action.enabled);
  }
  return true;
}

/** A checked running session survives expiry; ending it always removes the grant. */
export class LicenseAccess {
  private sessionGranted = false;
  private generation = 0;
  private workspaceGranted = false;
  constructor(private readonly status: () => Promise<LicenseStatus>) {}
  async authorize(channel: string, value: unknown): Promise<void> {
    // Saving work admitted under a paid license, and its recovery copy, must remain possible after expiry.
    if (workspaceSaveCalls.has(channel) && this.workspaceGranted) return;
    if (needsProductLicense(channel, value)) await this.requireOutput();
  }
  async requireOutput(): Promise<void> {
    if (this.sessionGranted) return;
    const status = await this.status();
    if (status.state !== 'active' || !status.claims || status.claims.kind === 'trial') throw new Error(`使用团播联动台需要有效授权：${status.message}${status.state === 'inactive' ? '。请购买并激活本机' : ''}。`);
    this.workspaceGranted = true;
  }
  async setActive(active: boolean): Promise<void> {
    if (!active) { this.generation += 1; this.sessionGranted = false; return; }
    const generation = this.generation;
    await this.requireOutput();
    if (generation !== this.generation) throw new Error('运行已停止，请重新开始');
    this.sessionGranted = true;
  }
}
