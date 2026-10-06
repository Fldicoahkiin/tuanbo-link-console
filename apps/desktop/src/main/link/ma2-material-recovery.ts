import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ma2EffectLibrarySchema, lightingMa2CueCatalogSchema, type LinkProject, type Ma2EffectLibrary, type Ma2ReadProgressUpdate } from '@tb/schema';
import { saveMa2MaterialLibraryCommand } from '@tb/core/link';
import { writeFileAtomically } from './atomic-file';

const headerSchema = z.object({ version: z.literal(1), id: z.string().uuid(), projectId: z.string(), source: z.string(), library: ma2EffectLibrarySchema }).strict();
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The producer awaits each write before reporting a saved sequence to the renderer. */
export class Ma2MaterialRecovery {
  private readonly id = randomUUID();
  private library: Ma2EffectLibrary | null = null;
  constructor(private readonly projectPath: string, private readonly projectId: string, private readonly source: string) {}
  private get root(): string { return `${this.projectPath}.ma2-material-recovery`; }
  private async header(): Promise<void> {
    await writeFileAtomically(join(this.root, 'active.json'), JSON.stringify(headerSchema.parse({ version: 1, id: this.id, projectId: this.projectId, source: this.source, library: this.library })));
  }
  async record(update: Ma2ReadProgressUpdate): Promise<void> {
    if (update.checkpoint) {
      this.library = { directory: update.checkpoint.directory, readAt: update.checkpoint.readAt, sequences: [], fixtureUsage: [], errors: [], fixtureDetails: 'unavailable', incomplete: '读取未完成，已完成序列可恢复', sourceUnverified: true };
      await this.header();
    }
    for (const sequence of update.sequences ?? []) {
      if (!this.library) throw new Error('素材检查点缺少来源目录');
      await writeFileAtomically(join(this.root, this.id, `${sequence.sequence}.json`), JSON.stringify(sequence));
    }
    if (update.libraryError) {
      if (!this.library) throw new Error('素材检查点缺少来源目录');
      await writeFileAtomically(join(this.root, this.id, `error-${update.libraryError.sequence}.json`), JSON.stringify(update.libraryError));
    }
  }
  async complete(library: Ma2EffectLibrary): Promise<void> {
    this.library = { ...library, sequences: [] };
    await this.header();
  }
}

export async function recoverMa2Material(projectPath: string, project: LinkProject): Promise<LinkProject> {
  const root = `${projectPath}.ma2-material-recovery`;
  let header: z.infer<typeof headerSchema>;
  try { header = headerSchema.parse(JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))); }
  catch (error) { if (missing(error)) return project; throw new Error('素材恢复记录损坏，原工程与记录均保留', { cause: error }); }
  if (header.projectId !== project.projectId) return project;
  const saved = project.ma2MaterialLibrary;
  if (saved && saved.library.readAt >= header.library.readAt && !saved.library.sourceUnverified) return project;
  let files: string[];
  try { files = await readdir(join(root, header.id)); } catch (error) { if (missing(error)) return project; throw error; }
  const library: Ma2EffectLibrary = { ...header.library, sequences: [], errors: [...header.library.errors] };
  for (const file of files.filter(value => /^error-\d+\.json$/.test(value))) {
    const target = Number(file.slice(6, -5));
    try {
      const error = ma2EffectLibrarySchema.shape.errors.element.parse(JSON.parse(await readFile(join(root, header.id, file), 'utf8')));
      if (error.sequence !== target || !library.directory.entries.some(entry => entry.target === target)) throw new Error('异常条目不属于目录');
      if (!library.errors.some(value => value.sequence === error.sequence)) library.errors.push(error);
    } catch (error) { library.errors.push({ sequence: target, message: `异常记录损坏，原文件保留：${error instanceof Error ? error.message : String(error)}` }); }
  }
  for (const file of files.filter(value => /^\d+\.json$/.test(value))) {
    const target = Number(file.slice(0, -5));
    if (!library.directory.entries.some(entry => entry.target === target)) throw new Error('素材恢复记录不属于当前目录');
    try {
      const sequence = lightingMa2CueCatalogSchema.parse([JSON.parse(await readFile(join(root, header.id, file), 'utf8'))])[0]!;
      if (sequence.sequence !== target) throw new Error('序列编号不一致');
      library.sequences.push(sequence);
    } catch (error) { library.errors.push({ sequence: target, message: `此序列恢复失败，原记录保留：${error instanceof Error ? error.message : String(error)}` }); }
  }
  if (saved?.source === header.source && saved.library.directory.show === library.directory.show && saved.library.directory.generation === library.directory.generation) {
    library.sequences.push(...saved.library.sequences.filter(sequence => library.directory.entries.some(entry => entry.target === sequence.sequence) && !library.sequences.some(entry => entry.sequence === sequence.sequence) && !library.errors.some(entry => entry.sequence === sequence.sequence)));
  }
  return saveMa2MaterialLibraryCommand(header.source, library).execute(project);
}
