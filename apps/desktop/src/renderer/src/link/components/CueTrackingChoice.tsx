import { Select } from '../ui';

/** Both places that copy console material use the same two MA2 Copy options. */
export function CueTrackingChoice({ label, value, disabled, onChange }: {
  label: string; value: boolean | undefined; disabled?: boolean; onChange: (includeTracking: boolean) => void;
}): JSX.Element {
  return <label>{label}<Select aria-label={label} value={value ? 'status' : 'content'} disabled={disabled}
    onChange={event => onChange(event.currentTarget.value === 'status')}>
    <option value="content">只复制这一步的改动</option>
    <option value="status">同时复制从前面继承的灯光</option>
  </Select></label>;
}
