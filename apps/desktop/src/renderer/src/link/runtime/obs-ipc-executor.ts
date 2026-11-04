import type { LinkActionExecutor, LinkDesktopApi } from '@tb/core/link';
import type { LinkAction } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

/** Show/hide-source cues act on the scene now on program (operator decision
 * 2026-10-19); every other OBS action runs as authored. */
export function executeObsCueAction(desktop: Pick<LinkDesktopApi, 'executeObsAction' | 'setObsProgramSourceEnabled'>, action: LinkAction): Promise<void> {
  return action.kind === 'obs.setSceneItemEnabled'
    ? desktop.setObsProgramSourceEnabled(action.sourceName, action.enabled)
    : desktop.executeObsAction(action);
}

export class ObsIpcExecutor implements LinkActionExecutor {
  readonly id = 'obs-ipc';

  supports(action: LinkAction): boolean {
    return action.kind.startsWith('obs.');
  }

  async execute(action: LinkAction): Promise<void> {
    await executeObsCueAction(linkDesktopViewModel, action);
  }
}
