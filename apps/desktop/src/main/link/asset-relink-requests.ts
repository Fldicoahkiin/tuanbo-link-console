import type { LinkProjectAssetFilesPayload, LinkProjectAssetRelinkPayload, LinkProjectAssetRelinkResult } from '@tb/schema';
import type { LinkProjectService } from './link-project-service';

/**
 * The window's requests to find and restore missing project files. They may
 * only name the project the window reported as open, and restore only from
 * the folder the operator last picked in the main process's folder dialog.
 */
export class AssetRelinkRequests {
  private picked: string | null = null;

  constructor(private readonly options: {
    projects: Pick<LinkProjectService, 'findMissingAssetFiles' | 'relinkAssetFiles'>;
    openProjectPath: () => string | null;
  }) {}

  /** The folder dialog's answer; cancelling (null) forgets the previous pick. */
  pickedSourceDirectory(directory: string | null): void {
    this.picked = directory;
  }

  async findMissing(payload: LinkProjectAssetFilesPayload): Promise<string[]> {
    this.requireOpenProject(payload.projectPath);
    return this.options.projects.findMissingAssetFiles(payload.projectPath, payload.files);
  }

  async relink(payload: LinkProjectAssetRelinkPayload): Promise<LinkProjectAssetRelinkResult> {
    this.requireOpenProject(payload.projectPath);
    if (this.picked === null || payload.sourceDirectory !== this.picked) throw new Error('原工程文件夹必须通过“选择原工程文件夹”选择');
    return this.options.projects.relinkAssetFiles(payload.projectPath, payload.sourceDirectory, payload.files);
  }

  private requireOpenProject(projectPath: string): void {
    if (projectPath !== this.options.openProjectPath()) throw new Error('只能检查和找回当前打开的工程的素材');
  }
}
