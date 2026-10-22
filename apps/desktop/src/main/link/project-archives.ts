import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { projectArchiveRequestSchema, projectArchiveResultSchema, projectArchiveSettingsSchema, type ProjectArchiveResult, type ProjectArchiveSettings, type ProjectArchiveSettingsStatus } from '@tb/schema';
import type { ProjectDocumentService } from './project-document-service';
import { writeFileAtomically } from './atomic-file';

export const DEFAULT_ARCHIVE_SETTINGS: ProjectArchiveSettings = { version: 1, enabled: true, directory: null, keep: 20, nameTemplate: '{工程名} {日期} {时间} {类型}' };
const INDEX = '.tblink-archives.json';
// The index is the only record of what this program wrote; files it does not list are never trimmed.
const indexSchema = z.object({ version: z.literal(1), projectPath: z.string(), entries: z.array(z.object({
  file: z.string().min(1), createdAt: z.iso.datetime(), reason: z.enum(['manual', 'before-sync'])
}).strict()) }).strict();
type Index = z.infer<typeof indexSchema>;
type Entry = ProjectArchiveResult['entries'][number];

/** Machine-level archive settings in userData; the archive root defaults to 文档\团播联动台\存档. */
export class ProjectArchiveSettingsStore {
  constructor(private readonly path: string, readonly defaultDirectory: string) {}
  async read(): Promise<ProjectArchiveSettings> {
    try { return projectArchiveSettingsSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return DEFAULT_ARCHIVE_SETTINGS; throw new Error('工程存档设置读取失败，请在设置中重新保存', { cause: error }); }
  }
  async write(settings: ProjectArchiveSettings): Promise<ProjectArchiveSettings> {
    const value = projectArchiveSettingsSchema.parse(settings);
    if (value.directory !== null && !isAbsolute(value.directory)) throw new Error('存档位置必须是完整的文件夹路径');
    await writeFileAtomically(this.path, JSON.stringify(value, null, 2));
    return value;
  }
  root(settings: ProjectArchiveSettings): string { return settings.directory ?? this.defaultDirectory; }
  async status(): Promise<ProjectArchiveSettingsStatus> {
    const settings = await this.read(); const directory = this.root(settings);
    let usageBytes = 0; let fileCount = 0;
    for (const folder of await listDirectory(directory)) {
      const index = await readIndex(join(directory, folder));
      for (const entry of index?.entries ?? []) {
        const size = await fileSize(join(directory, folder, entry.file));
        if (size !== null) { usageBytes += size; fileCount += 1; }
      }
    }
    return { settings, directory, defaultDirectory: this.defaultDirectory, usageBytes, fileCount };
  }
}

/** Archives go to <root>\<工程名>\; earlier ones beside the project are still listed and never moved or trimmed. */
export async function projectArchives(input: unknown, documents: Pick<ProjectDocumentService, 'save' | 'inspect'>, store: ProjectArchiveSettingsStore,
  reveal: (path: string) => void, trash: (path: string) => Promise<boolean>, now: () => Date = () => new Date()): Promise<ProjectArchiveResult> {
  const request = projectArchiveRequestSchema.parse(input);
  const projectPath = resolve(request.projectPath);
  if (extname(projectPath).toLowerCase() !== '.tblink' || !(await stat(projectPath)).isFile()) throw new Error('请先保存工程，再使用存档');
  const settings = await store.read();
  const root = store.root(settings);
  const projectName = basename(projectPath, extname(projectPath));
  let folder = await projectFolder(root, projectPath, projectName, false);
  const entries = async (): Promise<Entry[]> => {
    const listed: Entry[] = [...await legacyEntries(projectPath, projectName)];
    if (folder) for (const entry of (await readIndex(folder))?.entries ?? []) {
      if (await fileSize(join(folder, entry.file)) !== null) listed.push({ name: entry.file, path: join(folder, entry.file), createdAt: entry.createdAt, reason: entry.reason });
    }
    return listed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const archive = async (content: string, reason: Entry['reason'], kind: string): Promise<string> => {
    folder ??= await projectFolder(root, projectPath, projectName, true);
    const target = folder!;
    const index = await readIndex(target) ?? { version: 1 as const, projectPath, entries: [] };
    const created = now();
    const file = await freeName(target, renderName(settings.nameTemplate, projectName, created, kind));
    await documents.save(join(target, file), content);
    index.entries.push({ file, createdAt: created.toISOString(), reason });
    // Only automatic archives listed in this folder's index are trimmed, oldest first. An archive
    // the recycle bin refused stays listed, so it is retried next time instead of being forgotten.
    const automatic = index.entries.filter(entry => entry.reason === 'before-sync').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const entry of automatic.slice(settings.keep)) if (await trash(join(target, entry.file))) index.entries.splice(index.entries.indexOf(entry), 1);
    await writeFileAtomically(join(target, INDEX), JSON.stringify(index, null, 2));
    return join(target, file);
  };
  let createdPath: string | undefined;
  if (request.action === 'create') {
    if (request.reason === 'before-sync' && !settings.enabled) return projectArchiveResultSchema.parse({ version: 1, entries: await entries(), disabled: true });
    await documents.inspect(request.content);
    createdPath = await archive(request.content, request.reason, request.reason === 'manual' ? '手动' : '同步前');
  }
  if (request.action === 'reveal') {
    const entry = request.name ? (await entries()).find(value => value.name === request.name) : undefined;
    if (request.name && !entry) throw new Error('该存档不属于当前工程或已移动');
    reveal(entry?.path ?? folder ?? projectPath);
  }
  if (request.action === 'restore') {
    const entry = (await entries()).find(value => value.name === request.name);
    if (!entry) throw new Error('该存档不属于当前工程或已移动');
    const content = await readFile(entry.path, 'utf8');
    await documents.inspect(content);
    // The current file is archived first, so a restore can itself be undone from the list.
    await archive(await readFile(projectPath, 'utf8'), 'manual', '恢复前');
    await documents.save(projectPath, content);
  }
  return projectArchiveResultSchema.parse({ version: 1, entries: await entries(), ...(createdPath ? { createdPath } : {}) });
}

function renderName(template: string, project: string, at: Date, kind: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  const name = template.replaceAll('{工程名}', project).replaceAll('{日期}', date).replaceAll('{时间}', time).replaceAll('{类型}', kind);
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || `${project} ${date} ${time}`;
}
async function freeName(folder: string, name: string): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const file = `${name}${attempt > 1 ? ` (${attempt})` : ''}.tblink`;
    if (await fileSize(join(folder, file)) === null) return file;
  }
  throw new Error('同名存档过多，请清理存档文件夹');
}
/** One folder per project file; a folder whose index belongs to another project is skipped. */
async function projectFolder(root: string, projectPath: string, projectName: string, create: boolean): Promise<string | null> {
  const same = (path: string): boolean => process.platform === 'win32' ? path.toLowerCase() === projectPath.toLowerCase() : path === projectPath;
  const safe = projectName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  for (let attempt = 1; attempt < 100; attempt++) {
    const folder = join(root, attempt > 1 ? `${safe} (${attempt})` : safe);
    const index = await readIndex(folder);
    if (index && same(index.projectPath)) return folder;
    if (!index && create && !(await listDirectory(folder)).length) { await mkdir(folder, { recursive: true }); return folder; }
    if (!index && !create && !(await listDirectory(folder)).length) return null;
  }
  if (create) throw new Error('存档位置下同名工程文件夹过多，请清理后重试');
  return null;
}
async function readIndex(folder: string): Promise<Index | null> {
  try { return indexSchema.parse(JSON.parse(await readFile(join(folder, INDEX), 'utf8'))); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw new Error(`存档记录无法读取：${join(folder, INDEX)}`, { cause: error }); }
}
async function listDirectory(path: string): Promise<string[]> {
  try { return await readdir(path); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
}
async function fileSize(path: string): Promise<number | null> {
  try { return (await stat(path)).size; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}
/** Archives earlier versions wrote beside the project: listed and restorable, never trimmed. */
async function legacyEntries(projectPath: string, projectName: string): Promise<Entry[]> {
  const directory = dirname(projectPath); const prefix = `${projectName}.存档.`;
  return (await listDirectory(directory)).flatMap(name => {
    if (!name.startsWith(prefix)) return [];
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.(manual|before-sync|auto)\.[a-f0-9-]{36}\.tblink$/.exec(name.slice(prefix.length));
    if (!match) return [];
    return [{ name, path: join(directory, name), createdAt: match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3'), reason: match[2] === 'manual' ? 'manual' as const : 'before-sync' as const }];
  });
}
