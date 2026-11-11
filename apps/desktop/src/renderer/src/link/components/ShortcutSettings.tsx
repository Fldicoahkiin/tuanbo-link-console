import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';
import { Button, Card, Dialog, IconButton, Notice, Switch, TextInput } from '../ui';
import { useShortcutStore } from '../stores/shortcut-store';
import { ownKeys } from '../keys/key-owner';
import { chordLabel, chordOf, type KeyChord } from '../keys/key-chord';
import { KEYMAP, STOP_ANYWHERE, type KeyEntry, type KeyScope } from '../keys/keymap';
import { failureText, fixedReason, keyMarks, settingsKeymap, stopAnywhere, tableKeys } from '../keys/key-settings';

/*
 * 设置 → 快捷键 (K8, 04 设计 4.11): every key of the table (keys/keymap.ts), by where it works, beside 剪映's. The
 * editor's, the lighting workbench's and the timeline's keys and the stop key that works everywhere can be changed;
 * a change works at once and is kept on this computer (stores/shortcut-store.ts). A key another command has is
 * refused with its name (keys/key-settings.ts).
 */

type Group = { title: string; description: string; scopes: readonly KeyScope[] };
const GROUPS: readonly Group[] = [
  { title: '全局', description: '每一页都能用。', scopes: ['global'] },
  { title: '编辑器', description: '只在编辑器里起作用。', scopes: ['editor'] },
  { title: '灯光工作台', description: '只在灯光工作台里起作用；开着对话框或面板时不起作用。', scopes: ['lighting'] },
  { title: '时间线', description: '编辑器和灯光工作台的时间线共用，点一下时间线再按。灯光点的键在选中灯光片段时起作用。', scopes: ['timeline', 'lighting-points'] }
];

const sameKeys = (a: readonly KeyChord[], b: readonly KeyChord[]): boolean => a.length === b.length && a.every((chord, index) => chord === b[index]);

/**
 * A box that records one key: click it, press the key. Esc alone gives up; Tab moves on as everywhere. The router
 * leaves every key pressed in it to it (`ownKeys('*')`), the stop key too.
 */
function KeyRecorder({ chord, label, autoFocus = false, onChord, onCancel }: { chord: KeyChord | null; label: string; autoFocus?: boolean; onChord: (chord: KeyChord) => void; onCancel?: () => void }): JSX.Element {
  const [recording, setRecording] = useState(autoFocus);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.code === 'Tab' && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) { event.currentTarget.blur(); return; }
    if (event.repeat || /^(Control|Shift|Alt|Meta|OS)/.test(event.code)) return;
    const chord = chordOf(event.nativeEvent);
    event.currentTarget.blur();
    onChord(chord);
  };
  return <TextInput aria-label={label} width="auto" className="settings-key-input" {...ownKeys('*')} readOnly autoFocus={autoFocus}
    value={recording ? '请按新的键…' : chord === null ? '' : chordLabel(chord)}
    onFocus={() => setRecording(true)} onBlur={() => { setRecording(false); onCancel?.(); }} onKeyDown={onKeyDown} />;
}

/** The keys as they read, or 无 without one. */
function Chips({ chords }: { chords: readonly KeyChord[] }): JSX.Element {
  return chords.length ? <>{chords.map(chord => <kbd key={chord} className="settings-key-chip">{chordLabel(chord)}</kbd>)}</> : <span className="settings-key-muted">没有键</span>;
}

/** 剪映's name and keys for the command, and why ours differ where they do. */
function JianyingCell({ entry, changed }: { entry: KeyEntry; changed: boolean }): JSX.Element {
  const table = KEYMAP.find(item => item.scope === entry.scope && item.id === entry.id) ?? entry;
  return <div className="settings-key-jianying">
    {table.jianying ? <span>剪映「{table.jianying.name}」<Chips chords={table.jianying.keys} /></span> : <span className="settings-key-muted">剪映没有</span>}
    {table.differsFromJianying && !changed ? <span className="settings-key-differs">和剪映不一样：{table.differsFromJianying}</span> : null}
  </div>;
}

type RowProps = { entry: KeyEntry; mark: string | undefined; problem: string | null; onSet: (chords: readonly KeyChord[]) => void; onReset: () => void };

/** One command: what it does, its keys (to change, or fixed and why), 剪映's, and 恢复默认 once changed. */
function KeyRow({ entry, mark, problem, onSet, onReset }: RowProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const chords = entry.keys.map(binding => binding.chord);
  const changed = !sameKeys(chords, tableKeys(entry.scope, entry.id));
  const name = entry.label;
  const reason = fixedReason(entry);
  return <div className="settings-key-row">
    <div className="settings-key-what"><span>{name}</span>{mark ? <span className="settings-key-mark" role="note">{mark}</span> : null}</div>
    <div className="settings-key-ours">
      {reason !== null ? <><Chips chords={chords} /><span className="settings-key-muted">{reason}</span></> : <>
        {chords.map((chord, index) => <span className="settings-key-edit" key={chord}>
          <KeyRecorder chord={chord} label={`${name}的键 ${chordLabel(chord)}，点一下再按新的键`} onChord={next => onSet(chords.map((item, at) => at === index ? next : item))} />
          <IconButton label={`去掉${name}的键 ${chordLabel(chord)}`} icon={X} size="sm" onClick={() => onSet(chords.filter((_, at) => at !== index))} />
        </span>)}
        {chords.length === 0 && !adding ? <span className="settings-key-muted">没有键</span> : null}
        {adding ? <KeyRecorder chord={null} label={`给${name}加一个键`} autoFocus onChord={next => { setAdding(false); onSet([...chords, next]); }} onCancel={() => setAdding(false)} />
          : <IconButton label={`给${name}加一个键`} icon={Plus} size="sm" onClick={() => setAdding(true)} />}
      </>}
    </div>
    <JianyingCell entry={entry} changed={changed} />
    <div className="settings-key-actions">{changed ? <Button variant="ghost" size="sm" icon={RotateCcw} onClick={onReset}>恢复默认</Button> : null}</div>
    {problem ? <p className="settings-error settings-key-problem" role="alert">{problem}</p> : null}
  </div>;
}

/** Runs a change of the settings; the sentence it was refused with goes beside the row (`problem`). */
function useAttempt(): { problem: { row: string; text: string } | null; attempt: (row: string, change: () => void) => void } {
  const [problem, setProblem] = useState<{ row: string; text: string } | null>(null);
  return { problem, attempt: (row, change) => {
    try { change(); setProblem(null); } catch (reason) { setProblem({ row, text: failureText(reason) }); }
  } };
}

export function ShortcutSettings(): JSX.Element {
  const { settings, switchesOff, error, load, setKeys, resetKeys, setStopKey, resetAll, setSwitch } = useShortcutStore();
  const { problem, attempt } = useAttempt();
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { load(); }, [load]);
  const keymap = useMemo(() => settingsKeymap(settings), [settings]);
  const marks = useMemo(() => keyMarks(settings), [settings]);
  const stop = stopAnywhere(keymap);
  const rowProblem = (row: string): string | null => problem?.row === row ? problem.text : null;
  const row = (entry: KeyEntry): JSX.Element => {
    const id = `${entry.scope} ${entry.id}`;
    return <KeyRow key={id} entry={entry} mark={marks.commands.get(id)} problem={rowProblem(id)}
      onSet={chords => attempt(id, () => setKeys(entry.scope, entry.id, chords))} onReset={() => attempt(id, () => resetKeys(entry.scope, entry.id))} />;
  };
  return <>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <Card title="停止" description="两种停止在每一页都能用，保存在这台电脑上。"
      actions={<Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => setConfirmReset(true)}>全部恢复默认</Button>}>
      <Switch label="单按 Esc 停止" help={`关掉后，单按 Esc 只关闭面板、取消选中和取消拖动，不停止播放。${chordLabel(stop)} 在任何地方都能停止，开着对话框、正在拖动或在输入框里也行。`}
        checked={!switchesOff.has('plainEscapeStops')} onChange={event => attempt('switch', () => {
          try { setSwitch('plainEscapeStops', event.currentTarget.checked); }
          catch (reason) { throw new Error(`「单按 Esc 停止」没有保存成功：${failureText(reason)}。请再试一次。`); }
        })} />
      {rowProblem('switch') ? <p className="settings-error" role="alert">{rowProblem('switch')}</p> : null}
      <div className="settings-keys">
        <div className="settings-key-row">
          <div className="settings-key-what"><span>随时停止</span>{marks.stop ? <span className="settings-key-mark" role="note">{marks.stop}</span> : null}</div>
          <div className="settings-key-ours"><KeyRecorder chord={stop} label={`随时停止的键 ${chordLabel(stop)}，点一下再按新的键`} onChord={next => attempt('stop', () => setStopKey(next))} /></div>
          <div className="settings-key-jianying"><span className="settings-key-muted">要按住 Ctrl、Alt 或 Shift，或者用 F1–F12</span></div>
          <div className="settings-key-actions">{stop !== STOP_ANYWHERE ? <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => attempt('stop', () => setStopKey(STOP_ANYWHERE))}>恢复默认</Button> : null}</div>
          {rowProblem('stop') ? <p className="settings-error settings-key-problem" role="alert">{rowProblem('stop')}</p> : null}
        </div>
      </div>
    </Card>
    {GROUPS.map(group => <Card key={group.title} title={group.title} description={group.description}>
      <div className="settings-keys">{keymap.filter(entry => group.scopes.includes(entry.scope) && entry.id !== 'transport.stop').map(row)}</div>
    </Card>)}
    {confirmReset ? <Dialog title="全部恢复默认快捷键？" size="sm" onClose={() => setConfirmReset(false)} actions={<>
      <Button variant="secondary" onClick={() => setConfirmReset(false)}>取消</Button>
      <Button variant="primary" onClick={() => attempt('switch', () => { resetAll(); setConfirmReset(false); })}>恢复默认</Button>
    </>}><p>你改过的键和随时停止的键都会恢复成默认的。「单按 Esc 停止」开关不变。</p></Dialog> : null}
  </>;
}
