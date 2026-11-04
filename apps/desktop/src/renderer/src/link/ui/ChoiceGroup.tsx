import { useId, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type Choice<Value extends string> = { value: Value; title: string; help?: ReactNode; icon?: LucideIcon; preview?: ReactNode };

/**
 * One of a few ways of working, shown side by side as cards with a sentence each (for example
 * 联动台播放 / 跟随 P1). For a long list use Select.
 */
export function ChoiceGroup<Value extends string>({ label, value, choices, disabled = false, onChange }: {
  label: string;
  value: Value;
  choices: readonly Choice<Value>[];
  disabled?: boolean;
  onChange: (value: Value) => void;
}): JSX.Element {
  const name = useId();
  return <div className="ui-choices" role="radiogroup" aria-label={label}>
    {choices.map(({ value: option, title, help, icon: Icon, preview }) => <label className="ui-choice" key={option}>
      <input type="radio" name={name} value={option} checked={value === option} disabled={disabled} onChange={() => onChange(option)} />
      <span className="ui-choice-copy">
        <span className="ui-choice-title">{Icon ? <Icon aria-hidden="true" /> : null}{title}</span>
        {help ? <small>{help}</small> : null}
      </span>
      {preview ? <span className="ui-choice-preview" aria-hidden="true">{preview}</span> : null}
    </label>)}
  </div>;
}
