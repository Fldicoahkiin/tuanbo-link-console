import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomically } from './atomic-file';

/** A scene item transform as OBS takes it back (SetSceneItemTransform). */
export type OwnLook = Record<string, number | string | boolean>;

/** A material's own look in OBS, kept on this machine (0.5.9 E16): how OBS had the material's scene item before the
 * console first changed it. A clip that is not set shows the material this way. Keyed by the material decoder's input
 * name (the primary one: a standby copy shares it). Kept until the material's scene is created anew. */
export type MaterialOwnLooks = {
  read(decoder: string): Promise<OwnLook | null>;
  /** Keeps the decoder's own look and resolves once it is kept for good. A look kept before is never replaced. */
  keep(decoder: string, look: OwnLook): Promise<void>;
  /** The material's scene was created anew: its creation look is its own look now. */
  drop(decoder: string): Promise<void>;
  /** Whether the console made its picture filter (opacity, 0.5.9 E17) on this decoder input, primary or standby. */
  filterMade(input: string): Promise<boolean>;
  /** Resolves once it is kept for good: before the filter is created, so a filter of ours is never left unknown. */
  keepFilterMade(input: string): Promise<void>;
  /** The input has no filter of ours: it was created anew, or OBS refused to create the filter. */
  forgetFilterMade(input: string): Promise<void>;
};

/** Read-only fields OBS reports with a transform; they follow the source and are not set. */
const REPORTED_ONLY = new Set(['sourceWidth', 'sourceHeight', 'width', 'height']);

/** The settable part of a transform OBS reported. */
export function ownLookOf(transform: Record<string, unknown>): OwnLook {
  const look: OwnLook = {};
  for (const [key, value] of Object.entries(transform)) {
    if (REPORTED_ONLY.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' || typeof value === 'boolean') look[key] = value;
  }
  return look;
}

/** For tests, and for an adapter without a machine to keep them on. */
export class MemoryMaterialOwnLooks implements MaterialOwnLooks {
  readonly looks = new Map<string, OwnLook>();
  readonly filters = new Set<string>();
  read(decoder: string): Promise<OwnLook | null> { return Promise.resolve(this.looks.get(decoder) ?? null); }
  keep(decoder: string, look: OwnLook): Promise<void> { if (!this.looks.has(decoder)) this.looks.set(decoder, look); return Promise.resolve(); }
  drop(decoder: string): Promise<void> { this.looks.delete(decoder); return Promise.resolve(); }
  filterMade(input: string): Promise<boolean> { return Promise.resolve(this.filters.has(input)); }
  keepFilterMade(input: string): Promise<void> { this.filters.add(input); return Promise.resolve(); }
  forgetFilterMade(input: string): Promise<void> { this.filters.delete(input); return Promise.resolve(); }
}

/** `filters` (0.5.9 E17) is written only once a filter of ours exists, so a file without one stays as E16 wrote it. */
const recordSchema = z.object({ version: z.literal(1),
  looks: z.record(z.string().min(1), z.record(z.string(), z.union([z.number().finite(), z.string(), z.boolean()]))),
  filters: z.array(z.string().min(1)).optional() }).strict();
type KeptRecord = { looks: Map<string, OwnLook>; filters: Set<string> };

/** The machine's own looks, in one small JSON file under userData/link-integrations. Writes go one after another, and a
 * keep resolves only once the file is replaced on disk. */
export class FileMaterialOwnLooks implements MaterialOwnLooks {
  private loaded: KeptRecord | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  async read(decoder: string): Promise<OwnLook | null> { return (await this.load()).looks.get(decoder) ?? null; }
  keep(decoder: string, look: OwnLook): Promise<void> {
    return this.write(record => { if (record.looks.has(decoder)) return false; record.looks.set(decoder, look); return true; });
  }
  drop(decoder: string): Promise<void> { return this.write(record => record.looks.delete(decoder)); }
  async filterMade(input: string): Promise<boolean> { return (await this.load()).filters.has(input); }
  keepFilterMade(input: string): Promise<void> {
    return this.write(record => { if (record.filters.has(input)) return false; record.filters.add(input); return true; });
  }
  forgetFilterMade(input: string): Promise<void> { return this.write(record => record.filters.delete(input)); }

  private async load(): Promise<KeptRecord> {
    if (this.loaded) return this.loaded;
    let content: string;
    try { content = await readFile(this.file, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return this.loaded = { looks: new Map(), filters: new Set() };
      throw new Error(`读不了本机记下的素材原来的样子：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    try {
      const parsed = recordSchema.parse(JSON.parse(content));
      this.loaded = { looks: new Map(Object.entries(parsed.looks)), filters: new Set(parsed.filters ?? []) };
    }
    catch (error) { throw new Error(`本机记下的素材原来的样子损坏了：${this.file}`, { cause: error }); }
    return this.loaded;
  }

  /** `change` edits a copy; the copy becomes the book only once it is on disk. */
  private write(change: (record: KeptRecord) => boolean): Promise<void> {
    const next = this.turn.then(async () => {
      const current = await this.load(), record: KeptRecord = { looks: new Map(current.looks), filters: new Set(current.filters) };
      if (!change(record)) return;
      await writeFileAtomically(this.file, `${JSON.stringify({ version: 1, looks: Object.fromEntries(record.looks), ...record.filters.size ? { filters: [...record.filters] } : {} })}\n`);
      this.loaded = record;
    });
    this.turn = next.catch(() => undefined);
    return next;
  }
}
