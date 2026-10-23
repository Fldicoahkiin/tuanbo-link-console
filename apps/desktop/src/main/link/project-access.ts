import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from './atomic-file';
import { resolveProjectAssetFiles } from './link-project-service';

const lastProjectRecordSchema = z.object({ version: z.literal(1), projectPath: z.string().min(1).max(4096) }).strict();

/**
 * Which project files the window may name. Only the main process approves a project path: an open
 * or save dialog, its own record of the last project, or opening a path it already approved. The
 * window reports which approved project it shows, and requests inside a project folder must name it.
 */
export class ProjectAccess {
  private readonly approved = new Set<string>();
  private shown: string | null = null;
  private recorded: string | null = null;

  constructor(private readonly lastProjectFile: string) {}

  approve(path: string): void {
    this.approved.add(pathKey(path));
  }

  requireApproved(path: string): void {
    if (!this.approved.has(pathKey(path))) throw new Error(`工程路径未经本软件的打开或保存对话框确认，已拒绝：${path}`);
  }

  /** The window's report of the project it shows (null: unnamed or none), recorded as the last project. */
  async show(projectPath: string | null): Promise<void> {
    if (projectPath !== null) this.requireApproved(projectPath);
    this.shown = projectPath;
    if (projectPath === null || projectPath === this.recorded) return;
    await writeFileAtomically(this.lastProjectFile, `${JSON.stringify({ version: 1, projectPath })}\n`);
    this.recorded = projectPath;
  }

  requireShown(projectPath: string): void {
    if (this.shown === null || pathKey(this.shown) !== pathKey(projectPath)) throw new Error(`只能访问当前打开的工程：${projectPath}`);
  }

  /** The last project shown, from the main process's own record; reading it approves it for reopening. */
  async lastProject(): Promise<string | null> {
    let content: string;
    try {
      content = await readFile(this.lastProjectFile, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    let projectPath: string;
    try {
      projectPath = lastProjectRecordSchema.parse(JSON.parse(content)).projectPath;
    } catch (error) {
      throw new Error(`上次工程记录损坏：${this.lastProjectFile}`, { cause: error });
    }
    this.recorded = projectPath;
    this.approve(projectPath);
    return projectPath;
  }

  /** Absolute paths of asset files inside the shown project, after the one asset path check. */
  async assetFiles(projectPath: string, relativePaths: readonly string[]): Promise<string[]> {
    this.requireShown(projectPath);
    return resolveProjectAssetFiles(projectPath, relativePaths);
  }
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
