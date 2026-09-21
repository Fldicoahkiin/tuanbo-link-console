import { useState } from 'react';

export const FIXTURE_CATEGORIES = ['长条频闪', '龙卷风', '响尾蛇', '千手观音', '光束', '切割'];
export function parseFixtureRange(text: string): number[] {
  const values = new Set<number>();
  for (const part of text.trim().split(/[，,\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error('灯具编号格式为 101-120, 201');
    const start = Number(match[1]); const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 9999) throw new Error('灯具编号范围无效或超过一万盏');
    for (let value = start; value <= end; value++) values.add(value);
    if (values.size > 10000) throw new Error('单类灯具不能超过一万盏');
  }
  return [...values];
}
export function LightingFixtureMapping({ mappings, disabled, onApply }: { mappings: Record<string, number[]>; disabled: boolean; onApply: (value: Record<string, number[]>) => void }): JSX.Element {
  const [error, setError] = useState('');
  return <details className="fixture-mapping"><summary>灯具对应关系 · 设置一次，批量分类</summary><div>{FIXTURE_CATEGORIES.map(category => <label key={category}>{category}<input form="fixture-mapping" name={category} aria-label={`${category} 灯具编号`} placeholder="例如 101-120, 201" defaultValue={mappings[category]?.join(',') ?? ''} /></label>)}</div><form id="fixture-mapping" onSubmit={event => { event.preventDefault(); try { const data = new FormData(event.currentTarget); onApply(Object.fromEntries(FIXTURE_CATEGORIES.map(category => [category, parseFixtureRange(typeof data.get(category) === 'string' ? data.get(category) as string : '')]))); setError(''); } catch (cause) { setError(String(cause)); } }}><button disabled={disabled}>按灯具编号分类</button></form>{error ? <p role="alert">{error}</p> : null}</details>;
}
