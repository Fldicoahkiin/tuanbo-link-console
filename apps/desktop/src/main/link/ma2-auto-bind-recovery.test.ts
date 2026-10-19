import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { normalizeMa2AutoBindings, ma2AutoBindEvents } from '@tb/core/link';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import { recoverMa2AutoBinding } from './ma2-auto-bind-recovery';
import { prepareMa2MergedEvents } from './ma2-event-write';

const xml = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
function fixture() {
  const preview = convertMa2Timecode(xml, [sequence], 9902);
  const document = structuredClone(preview.document);
  document.tracks[0]!.id = 'local-track'; document.tracks[0]!.clips[0]!.id = 'local-clip';
  for (const [index, event] of document.tracks[0]!.clips[0]!.events.entries()) { event.id = `local-${index}`; if (event.kind === 'ma2') event.executor = ''; }
  return { preview, document };
}
it('restores lost associations without adding tracks or rewriting existing native events', () => {
  const { preview, document } = fixture();
  const plan = recoverMa2AutoBinding(document, preview, 'restored');
  const restored = normalizeMa2AutoBindings(document, plan);
  expect(restored.tracks).toHaveLength(1); expect(ma2AutoBindEvents(restored)).toEqual([]);
  expect(plan.newBinding?.mappings.map(entry => entry.eventId)).toEqual(['local-0', 'local-1']);
  const write = prepareMa2MergedEvents(restored, 'restored', preview, new Map(), new Map(), [sequence]);
  expect(write.desired.objects.filter(entry => entry.kind === 'event')).toHaveLength(2);
  expect(convertMa2Timecode(write.desiredXml, [sequence], 9902).document.tracks[0]!.clips[0]!.events.map(event => event.at)).toEqual([0, 1500]);
});
it('keeps local additions pending while restoring the existing baseline', () => {
  const { preview, document } = fixture();
  const clip = document.tracks[0]!.clips[0]!; clip.duration = 6000;
  clip.events.push({ ...clip.events[0]!, id: 'new-event', at: 5000 });
  const plan = recoverMa2AutoBinding(document, preview, 'restored');
  expect(plan.newBinding?.mappings).toHaveLength(2);
  const write = prepareMa2MergedEvents(normalizeMa2AutoBindings(document, plan), 'restored', preview, new Map(), new Map(), [sequence]);
  expect(convertMa2Timecode(write.desiredXml, [sequence], 9902).document.tracks[0]!.clips[0]!.events.map(event => event.at)).toEqual([0, 1500, 5000]);
});
it.each(['changed-time', 'duplicate', 'remote-only'] as const)('refuses unsafe recovery: %s', mode => {
  const { preview, document } = fixture(); const events = document.tracks[0]!.clips[0]!.events;
  if (mode === 'changed-time') events[0]!.at = 100;
  if (mode === 'duplicate') events.push({ ...events[0]!, id: 'duplicate' });
  if (mode === 'remote-only') events.pop();
  expect(() => recoverMa2AutoBinding(document, preview, 'restored')).toThrow('Timecode 9902');
  expect(document.ma2Bindings).toBeUndefined();
});
