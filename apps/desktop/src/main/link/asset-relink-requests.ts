import type { LinkProjectAssetFilesPayload, LinkProjectAssetRelinkPayload, LinkProjectAssetRelinkResult } from '@tb/schema';
import type { LinkProjectService } from './link-project-service';
import type { ProjectAccess } from './project-access';

/**
 * The window's requests to find and restore missing project files. They may
 * only name asset files of the project the window shows, and restore only from
 * the folder the operator last picked in the main process's folder dialog.
 */
export class AssetRelinkRequests {
  private picked: string | null = null;

  constructor(private readonly options: {
    projects: Pick<LinkProjectService, 'findMissingAssetFiles' | 'relinkAssetFiles'>;
    access: Pick<ProjectAccess, 'assetFiles'>;
  }) {}

  /** The folder dialog's answer; cancelling (null) forgets the previous pick. */
  pickedSourceDirectory(directory: string | null): void {
    this.picked = directory;
  }

  async findMissing(payload: LinkProjectAssetFilesPayload): Promise<string[]> {
    await this.options.access.assetFiles(payload.projectPath, payload.files.map(file => file.relativePath));
    return this.options.projects.findMissingAssetFiles(payload.projectPath, payload.files);
  }

  async relink(payload: LinkProjectAssetRelinkPayload): Promise<LinkProjectAssetRelinkResult> {
    if (this.picked === null || payload.sourceDirectory !== this.picked) throw new Error('原工程文件夹必须通过“选择原工程文件夹”选择');
    await this.options.access.assetFiles(payload.projectPath, payload.files.map(file => file.relativePath));
    return this.options.projects.relinkAssetFiles(payload.projectPath, payload.sourceDirectory, payload.files);
  }
}
