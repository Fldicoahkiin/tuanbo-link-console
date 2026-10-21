import { expect, it } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { confirmMa2RenameCommand, pendingMa2Renames, renameConsoleCueCommand, saveMa2MaterialLibraryCommand } from './link-public';

const source = { endpoint: '192.0.2.1:30000', show: 'Test' };
function project(confirmed: string) {
  const directory = { show: source.show, generation: 'session', version: '3.7.0.5', entries: [] };
  return saveMa2MaterialLibraryCommand(source.endpoint, { directory, readAt: new Date().toISOString(), fixtureUsage: [], errors: [],
    sequences: [{ sequence: 2, name: 'Sequence', cues: [{ index: 0, number: '1.100', name: confirmed }] }] }).execute(createEmptyLinkProject('Rename'));
}
it('中文改名以拼音写入控台并确认；控台已是对应拼音时不再待同步', () => {
  const renamed = renameConsoleCueCommand({ sequence: 2, cue: '1.100', kind: 'single' }, '面光', source).execute(project('Original'));
  const pending = pendingMa2Renames(renamed);
  expect(pending).toMatchObject([{ name: '面光', confirmedName: 'Original' }]);
  const confirmed = confirmMa2RenameCommand(pending[0]!).execute(renamed);
  expect(pendingMa2Renames(confirmed)).toEqual([]);
  expect(confirmed.ma2MaterialLibrary?.userLibrary?.consoleRenames?.[0]).toMatchObject({ name: '面光', confirmedName: 'MianGuang' });
  expect(confirmed.ma2MaterialLibrary?.library?.sequences[0]?.cues[0]?.name).toBe('MianGuang');
});
it('之前以中文确认过的改名在控台上还不是拼音，重新列为待同步', () => {
  const renamed = renameConsoleCueCommand({ sequence: 2, cue: '1.100', kind: 'single' }, '面光', source).execute(project('Original'));
  const library = renamed.ma2MaterialLibrary!.userLibrary!;
  const legacy = { ...renamed, ma2MaterialLibrary: { ...renamed.ma2MaterialLibrary!, userLibrary: { ...library, consoleRenames: library.consoleRenames!.map(record => ({ ...record, confirmedName: '面光' })) } } };
  expect(pendingMa2Renames(legacy)).toMatchObject([{ name: '面光', confirmedName: '面光' }]);
});
