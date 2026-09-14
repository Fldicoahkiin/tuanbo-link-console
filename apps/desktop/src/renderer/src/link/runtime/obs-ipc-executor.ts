import type { LinkActionExecutor } from '@tb/core/link';
import type { LinkAction } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export class ObsIpcExecutor implements LinkActionExecutor {
  readonly id = 'obs-ipc';

  supports(action: LinkAction): boolean {
    return action.kind.startsWith('obs.');
  }

  async execute(action: LinkAction): Promise<void> {
    await linkDesktopViewModel.executeObsAction(action);
  }
}
