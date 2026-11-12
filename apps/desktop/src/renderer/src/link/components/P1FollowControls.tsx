import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toUserErrorMessage } from '@tb/core/link';
import { P1_FOLLOW_PAGE } from '../runtime/p1-follow-client';
import { p1FollowClient, useP1FollowStore } from '../stores/p1-follow-store';
import { p1FollowStatus } from '../view-models/status-center';
import type { ConnectionStatus } from '../view-models/connection-status';
import { Button } from '../ui';

const TONES: Record<ConnectionStatus['state'], string> = { ready: 'live', warning: 'held', checking: 'busy', error: 'error', idle: 'idle', skipped: 'idle' };

/** The follow's state on the home page's P1 panel (0.5.9 P4), where it said only 「P1 跟随」 before. */
export function P1FollowStateChip(): JSX.Element {
  const follow = useP1FollowStore(state => state.follow);
  const status = p1FollowStatus(follow);
  return <span className="home-player-state" data-tone={TONES[status.state]} title={status.detail} {...status.state === 'error' ? { role: 'alert' } : {}}>{status.value}</span>;
}

/** Only for this page's manual follow whose timecode froze: the one way on from there. The follow says why it refuses. */
export function P1FollowResync({ notify }: { notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const follow = useP1FollowStore(state => state.follow);
  const [sending, setSending] = useState(false);
  if (follow?.phase !== 'frozen' || follow.mode !== 'manual' || follow.ownerId !== P1_FOLLOW_PAGE) return null;
  const resync = (): void => {
    setSending(true);
    void p1FollowClient().resync()
      .catch((error: unknown) => notify(`没能重新同步：${toUserErrorMessage(error)}`, 'error'))
      .finally(() => setSending(false));
  };
  return <div className="home-player-controls" role="group" aria-label="重新同步">
    <p className="home-player-empty">联动台从 P1 现在的位置接着跟；时间码停着时错过的动作不补发。</p>
    <Button variant="primary" size="sm" icon={RefreshCw} disabled={sending} onClick={resync}>重新同步</Button>
  </div>;
}
