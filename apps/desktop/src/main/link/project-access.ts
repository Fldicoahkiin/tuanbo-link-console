import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isProjectAssetPath } from '@tb/core/link';
import { writeFileAtomically } from './atomic-file';
import type { ChosenPaths } from './chosen-paths';
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
  /** Opened or saved by the main process for the window, until the window reports showing it. */
  private opening: string | null = null;
  private recorded: string | null = null;
  /** tblink-asset:// tokens, each for one file of the project it was issued for. */
  private readonly assetLinks = new Map<string, { projectPath: string; path: string }>();

  constructor(private readonly lastProjectFile: string) {}

  approve(path: string): void {
    this.approved.add(pathKey(path));
  }

  /** The main process just opened or saved this project for the window, which is about to show it.
   * Requests for it are accepted from now on, so the views need not wait for the window's report;
   * the project still on screen stays accepted too, and a report still on its way does not undo this. */
  opened(path: string): void {
    this.approve(path);
    this.opening = path;
    this.forgetClosedAssetLinks();
  }

  requireApproved(path: string): void {
    if (!this.approved.has(pathKey(path))) throw new Error(`这个工程路径不是通过联动台打开或保存的，已拒绝：${path}`);
  }

  /** The window's report of the project it shows (null: unnamed or none), recorded as the last project. */
  async show(projectPath: string | null): Promise<void> {
    if (projectPath !== null) this.requireApproved(projectPath);
    this.shown = projectPath;
    if (projectPath !== null && this.opening !== null && pathKey(projectPath) === pathKey(this.opening)) this.opening = null;
    this.forgetClosedAssetLinks();
    if (projectPath === null || projectPath === this.recorded) return;
    await writeFileAtomically(this.lastProjectFile, `${JSON.stringify({ version: 1, projectPath })}\n`);
    this.recorded = projectPath;
  }

  requireShown(projectPath: string): void {
    if (!this.isOpen(projectPath)) throw new Error(`只能访问当前打开的工程：${projectPath}`);
  }

  /** A tblink-asset:// link for a file of the shown project; it stops working once that project is closed or replaced. */
  assetUrl(projectPath: string, path: string): string {
    this.requireShown(projectPath);
    const token = randomUUID();
    this.assetLinks.set(token, { projectPath, path });
    return `tblink-asset://local/${token}`;
  }

  /** The file behind a link token, or null when the token is unknown or its project is no longer open. */
  assetPath(token: string): string | null {
    const link = this.assetLinks.get(token);
    return link && this.isOpen(link.projectPath) ? link.path : null;
  }

  private isOpen(projectPath: string): boolean {
    const key = pathKey(projectPath);
    return [this.shown, this.opening].some(path => path !== null && pathKey(path) === key);
  }

  private forgetClosedAssetLinks(): void {
    for (const [token, link] of this.assetLinks) if (!this.isOpen(link.projectPath)) this.assetLinks.delete(token);
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
      throw new Error(`上次打开的工程记录已损坏：${this.lastProjectFile}`, { cause: error });
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

  /** An import into the shown project reads a file the operator chose, or one of its own assets again. */
  async requireImportSource(projectPath: string, sourcePath: string, chosen: Pick<ChosenPaths, 'has'>): Promise<void> {
    this.requireShown(projectPath);
    if (chosen.has(sourcePath)) return;
    const asset = relative(dirname(resolve(projectPath)), resolve(sourcePath)).replaceAll('\\', '/');
    if (!isProjectAssetPath(asset)) throw new Error(`这个文件不是通过联动台选择或拖入的，已拒绝：${sourcePath}`);
    await resolveProjectAssetFiles(projectPath, [asset]);
  }
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
