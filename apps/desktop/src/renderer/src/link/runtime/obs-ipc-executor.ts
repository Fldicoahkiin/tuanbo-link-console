import type { LinkActionExecutor, LinkDesktopApi } from '@tb/core/link';
import type { LinkAction, LinkProject } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

/** Full-scene projects apply show/hide-source cues to the scene now on program
 * (operator decision 2026-10-19); every other OBS action runs as authored. */
export function executeObsCueAction(desktop: Pick<LinkDesktopApi, 'executeObsAction' | 'setObsProgramSourceEnabled'>,
  project: LinkProject, action: LinkAction): Promise<void> {
  return project.obsOutputMode === 'scenes' && action.kind === 'obs.setSceneItemEnabled'
    ? desktop.setObsProgramSourceEnabled(action.sourceName, action.enabled)
    : desktop.executeObsAction(action);
}

export class ObsIpcExecutor implements LinkActionExecutor {
  readonly id = 'obs-ipc';

  constructor(private readonly project: () => LinkProject) {}

  supports(action: LinkAction): boolean {
    return action.kind.startsWith('obs.');
  }

  async execute(action: LinkAction): Promise<void> {
    await executeObsCueAction(linkDesktopViewModel, this.project(), action);
  }
}
