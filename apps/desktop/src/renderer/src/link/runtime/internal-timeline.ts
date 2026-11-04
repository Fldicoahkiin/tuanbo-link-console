import { millisecondsToFrameNumber, frameNumberToTimecode, type MtcSample } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

export function internalSample(project: LinkProject, positionMs: number): MtcSample {
  const totalFrames = millisecondsToFrameNumber(positionMs, project.timebase.frameRate);
  return { totalFrames, timecode: frameNumberToTimecode(totalFrames, project.timebase.frameRate),
    frameRate: project.timebase.frameRate, direction: 'forward', receivedAtMs: performance.now() };
}
