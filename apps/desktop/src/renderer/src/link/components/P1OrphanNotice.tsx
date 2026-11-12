import { useState } from 'react';
import { toUserErrorMessage } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { p1FollowClient, useOrphanP1Follow } from '../stores/p1-follow-store';
import { Button } from '../ui';

/**
 * A P1 follow that went on while the window reloaded, for another project than the one open here (0.5.9 P4): it is
 * never taken over across projects and never ended without the operator. The page with its project takes it back on
 * its own (useP1AutoFollow).
 */
export function P1OrphanNotice({ notify }: { notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const orphan = useOrphanP1Follow();
  const ownProject = useDocumentStore(state => state.project !== null && state.project.playbackSource !== 'internal' && state.path === orphan?.projectPath);
  const [stopping, setStopping] = useState(false);
  if (!orphan || ownProject) return null;
  const stop = (): void => {
    setStopping(true);
    void p1FollowClient().close().then(() => notify(`已停止跟随 P1（工程「${orphan.projectName}」）。`),
      (error: unknown) => notify(`没能停止跟随 P1：${toUserErrorMessage(error)}`, 'error')).finally(() => setStopping(false));
  };
  return <div className="toast info" role="status">
    <span>工程「{orphan.projectName}」还在跟随 P1：联动台重新打开之前开始的跟随还在继续。要接着用，请打开这个工程；不用了就停止它。</span>
    <Button variant="secondary" size="sm" disabled={stopping} onClick={stop}>停止跟随</Button>
  </div>;
}
