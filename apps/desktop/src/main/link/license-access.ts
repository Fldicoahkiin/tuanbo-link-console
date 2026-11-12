import { linkActionSchema, linkManagedMediaExecutionPayloadSchema, ma2PlaybackRequestSchema, type LicenseStatus } from '@tb/schema';
import { nativePlayerControlSchema, p1FollowRequestSchema } from '@tb/schema';

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
  'link:set-document-state', 'link:resolve-unsaved-changes', 'link:save-response',
  // The show state is read and reported only; whether an output may start stays licensed where it starts.
  'link:show-state-get', 'link:show-activity',
  // The lights-off ledger: the window's previews say what they use and what they owe; it only ever sends Off.
  'link:lighting-off',
  // What its read-back found (M8), read only.
  'link:lighting-off-check-get',
  // P1 follow's state, read only (0.5.9 P3f).
  'link:p1-follow-state-get'
]);

const workspaceSaveCalls = new Set(['link:save-project', 'link:write-recovery-copy', 'link:discard-recovery-copy',
  'link:project-document-worker', 'link:restart-project-document-worker']);

/** Stopping never waits for a license: stop, pause, Off, mute and hide end what a checked run started (2026-11-09,
 * docs/LICENSE_IMPLEMENTATION.md, license-rules.test.ts). Anything that starts output or sends new content stays licensed.
 * Action MIDI decides by the same rule in one place, midiMessageNeedsLicense (packages/core midi-program.ts). */
export function needsProductLicense(channel: string, value: unknown): boolean {
  if (publicCalls.has(channel)) return false;
  if (channel === 'link:native-player-control') {
    const control = nativePlayerControlSchema.parse(value);
    return control.kind !== 'stop' && control.kind !== 'pause' && control.kind !== 'stop-mtc';
  }
  // A stopped song switches its executors off; Go and Goto light them.
  if (channel === 'link:ma2-play-cue') return ma2PlaybackRequestSchema.parse(value).action.action !== 'off';
  if (channel === 'link:set-runtime-active') return value !== false;
  // Stopping a P1 follow and leaving it end what a checked follow started (0.5.9 P3f); a reloaded page taking back the
  // follow that went on meanwhile starts nothing (P4).
  if (channel === 'link:p1-follow') { const kind = p1FollowRequestSchema.parse(value).command.kind; return kind !== 'stop' && kind !== 'close' && kind !== 'adopt'; }
  if (channel === 'link:obs-execute-managed-media') return linkManagedMediaExecutionPayloadSchema.parse(value).event.phase === 'start';
  if (channel === 'link:obs-execute') {
    const action = linkActionSchema.parse(value);
    return !(action.kind === 'obs.mediaAction' && (action.action === 'stop' || action.action === 'pause')
      || action.kind === 'obs.setInputMute' && action.muted
      || action.kind === 'obs.setSceneItemEnabled' && !action.enabled);
  }
  return true;
}

/** A checked running session survives expiry until its show is over (license-reminders: a show running at expiry is
 * not interrupted). The window holds the session while its run is active. The main-process program holds it while it
 * keeps running the show the window checked, so a window that reloads or turns idle for a moment does not end a show
 * still on air. A program that stops lets go, and once the window's run has ended too the next show is checked again.
 * Not guaranteed: a song started right after a stop, before the window's idle reaches main, still passes on the window's
 * run, as it did with the single session grant before 0.5.9. */
export class LicenseAccess {
  private windowHolds = false;
  private programRunning = false;
  /** The program was running when the window last confirmed the session, and has kept running since. */
  private programHolds = false;
  private generation = 0;
  private workspaceGranted = false;
  constructor(private readonly status: () => Promise<LicenseStatus>) {}
  async authorize(channel: string, value: unknown): Promise<void> {
    // Saving work admitted under a paid license, and its recovery copy, must remain possible after expiry.
    if (workspaceSaveCalls.has(channel) && this.workspaceGranted) return;
    if (needsProductLicense(channel, value)) await this.requireOutput();
  }
  async requireOutput(): Promise<void> {
    if (this.windowHolds || this.programHolds) return;
    const status = await this.status();
    if (status.state !== 'active' || !status.claims || status.claims.kind === 'trial') throw new Error(`使用团播联动台需要有效授权：${status.message}${status.state === 'inactive' ? '。请购买并激活本机' : ''}。`);
    this.workspaceGranted = true;
  }
  /** The window's run starts (checked) or ends. */
  async setActive(active: boolean): Promise<void> {
    if (!active) { this.generation += 1; this.windowHolds = false; return; }
    const generation = this.generation;
    await this.requireOutput();
    if (generation !== this.generation) throw new Error('运行已停止，请重新开始');
    this.windowHolds = true; this.programHolds = this.programRunning;
  }
  /** The main-process program is preparing, playing or paused (NativeProgramService), also with no window attached. */
  setProgramRunning(running: boolean): void {
    this.programRunning = running;
    if (!running) this.programHolds = false;
  }
}
