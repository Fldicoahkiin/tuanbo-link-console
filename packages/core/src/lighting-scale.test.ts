import { expect, it } from 'vitest';
import { createLightingDocument, type LightingTrack } from '@tb/schema';
import { compileLightingPackets, LightingScheduler } from './lighting-playback';

it('32 轨 10 万音符编译并完整调度，不重复或遗漏释放', () => {
  const document = createLightingDocument(); document.outputMode = 'direct';
  document.tracks = Array.from({ length: 32 }, (_, index): LightingTrack => ({
    id: `track-${index}`, name: `Track ${index}`, kind: 'midi', color: '#abcdef', group: '', muted: false, solo: false, locked: false,
    channel: index % 16 + 1, portProfileId: `port-${Math.floor(index / 16)}`, controller: 7, noteNames: {},
    clips: [{ id: `clip-${index}`, name: '压力测试', start: 0, duration: 312500, timeLock: 'time', muted: false,
      events: Array.from({ length: 3125 }, (_, event) => ({ id: `${index}-${event}`, kind: 'note' as const, at: event * 100, duration: 50, note: event % 128, velocity: 100 })) }]
  }));
  const started = performance.now(); const packets = compileLightingPackets(document);
  expect(packets).toHaveLength(200000);
  let ons = 0; let offs = 0;
  const scheduler = new LightingScheduler(packets, (packet) => { if (packet.phase === 'on') ons += 1; if (packet.phase === 'off') offs += 1; });
  scheduler.locate(0);
  for (let ms = 0; ms <= 312500; ms += 25) scheduler.tick(ms);
  scheduler.stop(); expect(ons).toBe(100000); expect(offs).toBe(100000);
  expect(performance.now() - started).toBeLessThan(10000);
}, 15000);
