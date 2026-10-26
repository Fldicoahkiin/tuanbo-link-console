import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ma2CatalogSchema, ma2CatalogEntrySchema, type LinkProject, type Ma2Catalog } from '@tb/schema';
import { reconcileMa2ReadState, saveMa2ReadStateCommand } from '@tb/core/link';
import { writeFileAtomically } from './atomic-file';

const headerSchema = z.object({ version: z.literal(1), id: z.string().uuid(), projectId: z.string(), source: z.string(), catalog: ma2CatalogSchema }).strict();
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Per-object atomic files: a growing Show is never rewritten on every checkpoint. */
export class Ma2ReadRecovery {
  private readonly id = randomUUID();
  private initialized = false;
  constructor(private readonly projectPath: string, private readonly projectId: string, private readonly source: string) {}
  async checkpoint(catalog: Ma2Catalog, entry?: Ma2Catalog['entries'][number]): Promise<void> {
    const root = `${this.projectPath}.ma2-recovery`;
    const header = headerSchema.parse({ version: 1, id: this.id, projectId: this.projectId, source: this.source, catalog: { ...catalog, entries: [] } });
    if (!this.initialized) {
      await writeFileAtomically(join(root, 'active.json'), JSON.stringify(header));
      this.initialized = true;
    }
    if (entry) await writeFileAtomically(join(root, this.id, `${entry.target}.json`), JSON.stringify(ma2CatalogEntrySchema.parse(entry)));
    else await writeFileAtomically(join(root, 'active.json'), JSON.stringify(header));
  }
}

export async function recoverMa2Read(projectPath: string, project: LinkProject): Promise<LinkProject> {
  const root = `${projectPath}.ma2-recovery`;
  let header: z.infer<typeof headerSchema>;
  try { header = headerSchema.parse(JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))); }
  catch (error) { if (missing(error)) return project; throw new Error('控台读取的恢复记录已损坏，原工程和读取进度都已保留，请导出诊断包发给售后', { cause: error }); }
  if (header.projectId !== project.projectId) return project;
  const saved = project.ma2ReadState;
  if (saved && saved.catalog.readAt > header.catalog.readAt) return project;
  let files: string[];
  try { files = await readdir(join(root, header.id)); }
  catch (error) { if (missing(error)) return project; throw error; }
  const entries: Ma2Catalog['entries'] = [];
  for (const file of files.filter(value => /^\d+\.json$/.test(value))) {
    const target = Number(file.slice(0, -5));
    const object = header.catalog.directory.entries.find(value => value.target === target);
    if (!object) throw new Error('恢复条目不属于本次控台目录');
    try {
      const entry = ma2CatalogEntrySchema.parse(JSON.parse(await readFile(join(root, header.id, file), 'utf8')));
      if (entry.target !== target) throw new Error('恢复条目编号与文件不一致');
      entries.push(entry);
    } catch (error) {
      entries.push({ ...object, eventCount: null, frameFormat: null, offset: null, slot: null, events: [], warnings: [], error: `此条恢复记录损坏，原文件保留：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (!entries.length) return project;
  const sameSource = saved?.source === header.source && saved.catalog.directory.show === header.catalog.directory.show && saved.catalog.directory.generation === header.catalog.directory.generation;
  if (sameSource && saved.catalog.sourceUnverified === header.catalog.sourceUnverified && entries.every(entry => saved.catalog.entries.some(old => old.target === entry.target && old.readAt === entry.readAt && old.sourceXml === entry.sourceXml && old.error === entry.error))) return project;
  const retained = sameSource ? saved.catalog.entries.filter(old => !entries.some(entry => entry.target === old.target) && header.catalog.directory.entries.some(entry => entry.target === old.target)) : [];
  const catalog = ma2CatalogSchema.parse({ ...header.catalog, entries: [...retained, ...entries], incomplete: '已恢复中断前保存的读取结果；请检查后补读没读完的部分' });
  const state = reconcileMa2ReadState(project, header.source, catalog);
  return saveMa2ReadStateCommand(state).execute(project);
}
