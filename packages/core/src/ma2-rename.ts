import { ma2LabelSchema, parseLinkProject, type LinkProject, type LightingUserLibrary, type Ma2RenameRecord } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { projectLightingLibrary, setLightingLibraryCommand } from './lighting-library';
import { consoleLabelText, toConsoleLabel } from './ma2-console-label';

export function ma2RenameKey(value: Pick<Ma2RenameRecord, 'endpoint' | 'show' | 'sequence' | 'kind' | 'cue'>): string {
  return JSON.stringify([value.endpoint, value.show, value.sequence, value.kind, value.kind === 'sequence' ? '' : Number(value.cue)]);
}
export function pendingMa2Renames(project: LinkProject | null): Ma2RenameRecord[] {
  // confirmedName holds the console's own label; a Chinese name is pending until its pinyin is there.
  return project?.ma2MaterialLibrary?.userLibrary?.consoleRenames?.filter(change => consoleLabelText(change.name) !== change.confirmedName) ?? [];
}
/** Only an explicit rename enrolls an object; old local aliases never become a bulk write. */
export function queueMa2Rename(library: LightingUserLibrary, change: Ma2RenameRecord): LightingUserLibrary {
  const name = ma2LabelSchema.parse(change.name);
  const key = ma2RenameKey(change);
  // A fresh, explicit rename uses the latest scanned name. Merely refreshing the
  // catalog never rebases an already pending write or resolves a conflict.
  const record = { ...change, name };
  return { ...library, consoleRenames: [...(library.consoleRenames ?? []).filter(value => ma2RenameKey(value) !== key), record] };
}
/** Advance the external baseline across undo/redo, retaining edits made during I/O. */
export function confirmMa2RenameCommand(sent: Ma2RenameRecord): LinkCommand {
  const key = ma2RenameKey(sent);
  const rebase = (project: LinkProject): LinkProject => {
    const library = projectLightingLibrary(project);
    const current = library.consoleRenames?.find(value => ma2RenameKey(value) === key);
    const label = toConsoleLabel(sent.name);
    const record = { ...sent, name: current?.name ?? sent.confirmedName, confirmedName: label };
    const next = setLightingLibraryCommand({ ...library, consoleRenames: [...(library.consoleRenames ?? []).filter(value => ma2RenameKey(value) !== key), record] }).execute(project);
    const pool = next.ma2MaterialLibrary;
    if (pool?.library && pool.source === sent.endpoint && pool.library.directory.show === sent.show) {
      next.ma2MaterialLibrary = { ...pool, library: { ...pool.library, sequences: pool.library.sequences.map(sequence => sequence.sequence !== sent.sequence ? sequence : sent.kind === 'sequence'
        ? { ...sequence, name: label }
        : { ...sequence, cues: sequence.cues.map(cue => Number(cue.number) === Number(sent.cue) ? { ...cue, name: label } : cue) }) } };
    }
    return parseLinkProject(next);
  };
  return { id: crypto.randomUUID(), label: '确认控台名称', historyRebaseKey: `ma2-label:${key}`, rebaseHistory: rebase, execute: rebase, undo: before => before };
}
