import { useEffect, useRef } from 'react';
import { ma2NetworkStatusSchema, type LinkProject } from '@tb/schema';
import { toUserErrorMessage } from '@tb/core/link';
import type { ProjectPlayer } from '../components/ProjectPlayerControls';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { publishConsoleFollow } from '../stores/console-follow-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { ConsoleFollowMonitor } from './console-follow-monitor';

const READ_EVERY_MS = 1000;

/** While a song plays, reads back about once a second whether the console follows its timecode. */
export function useConsoleFollow(player: ProjectPlayer, project: LinkProject | null): void {
  const projectRef = useRef(project); projectRef.current = project;
  const monitor = useRef<ConsoleFollowMonitor | null>(null);
  monitor.current ??= new ConsoleFollowMonitor({
    project: () => projectRef.current,
    method: () => useMa2ModeStore.getState().method,
    network: async () => {
      const status = ma2NetworkStatusSchema.parse(await desktop.getMa2NetworkStatus());
      if (status.state !== 'connected' || !status.settings) return null;
      const { host, port, monitorPort, username } = status.settings;
      return { host, port, monitorPort, username };
    },
    observe: request => window.tbLink.observeMa2Executor(request),
    release: () => window.tbLink.releaseMa2Observer(),
    publish: publishConsoleFollow,
    log: (level, message, itemId) => {
      void desktop.recordLog({ level, category: 'device', device: 'MA2', message, itemId, ...(projectRef.current ? { projectId: projectRef.current.projectId } : {}) })
        .catch((error: unknown) => console.error('控台在不在跟的记录没写进日志', toUserErrorMessage(error)));
    }
  });
  const { status, itemId } = player.state;
  const controller = player.controller;
  useEffect(() => {
    const follow = monitor.current!;
    if (status !== 'playing' || !itemId) { follow.idle(); return; }
    follow.start(itemId, player.view.readClock().positionMs);
    // A jump plays from elsewhere: only the triggers the console passes from there count.
    const boundary = controller?.clock.subscribeBoundary(event => { if (event === 'seek') follow.start(itemId, player.view.readClock().positionMs); });
    const timer = window.setInterval(() => {
      const clock = player.view.readClock();
      void follow.tick(clock.positionMs, clock.mtcSentPositionMs !== null);
    }, READ_EVERY_MS);
    return () => { window.clearInterval(timer); boundary?.(); };
  }, [status, itemId, controller, player.view]);
}
