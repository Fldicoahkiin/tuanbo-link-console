import type { LinkMediaAsset } from '@tb/schema';

type PreparationInput = { documentId: number; projectPath: string | null; assets: readonly LinkMediaAsset[]; idle: boolean };
type ImportAudio = (request: { projectPath: string; sourcePath: string; durationMs: number }) => Promise<unknown>;

/** Populate the on-disk audio cache while browsing, not at the first drop.
 * One job at a time; document/playback changes discard queued work. Failures
 * are reported once, never retried by rendering or unrelated document edits. */
export class MediaAudioPreparation {
  private input: PreparationInput | null = null;
  private readonly attempted = new Set<string>();
  private running = false;
  private disposed = false;

  constructor(private readonly prepare: ImportAudio, private readonly report: (message: string) => void) {}

  update(input: PreparationInput): void {
    if (this.disposed) return;
    if (this.input?.documentId !== input.documentId || this.input.projectPath !== input.projectPath) this.attempted.clear();
    this.input = input;
    if (!this.running) void this.drain();
  }

  dispose(): void { this.disposed = true; this.input = null; this.attempted.clear(); }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (!this.disposed) {
        const input = this.input;
        if (!input?.idle || !input.projectPath) break;
        const asset = input.assets.find(value => value.kind === 'video' && !this.attempted.has(identity(value)));
        if (!asset) break;
        this.attempted.add(identity(asset));
        try {
          if (!asset.durationMs) throw new Error('视频缺少可用时长');
          const directory = input.projectPath.slice(0, Math.max(input.projectPath.lastIndexOf('/'), input.projectPath.lastIndexOf('\\')) + 1);
          await this.prepare({ projectPath: input.projectPath, sourcePath: directory + asset.relativePath, durationMs: asset.durationMs });
        } catch (error) {
          if (error instanceof Error && error.message.includes('素材不包含音频轨道')) continue;
          if (!this.disposed && this.input?.documentId === input.documentId && this.input.projectPath === input.projectPath) {
            this.report(`${asset.name} 原声准备失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } finally { this.running = false; }
  }
}

function identity(asset: LinkMediaAsset): string {
  return JSON.stringify([asset.id, asset.relativePath, asset.sha256, asset.durationMs]);
}
