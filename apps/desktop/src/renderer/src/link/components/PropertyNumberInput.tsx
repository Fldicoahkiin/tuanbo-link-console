import { useFieldDraft } from './useFieldDraft';

/** Commit a complete numeric edit; empty or invalid drafts never change the project.
 * While the field has focus it keeps what was typed; otherwise it shows `value` (useFieldDraft). */
export function PropertyNumberInput(props: {
  value: number;
  onCommit: (value: number) => void | boolean;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  disabled?: boolean;
  /** Set when the input sits in a labelled Field. */
  id?: string;
  className?: string;
  'aria-describedby'?: string;
}): JSX.Element {
  const displayed = props.precision === undefined ? String(props.value) : String(Number(props.value.toFixed(props.precision)));
  const draft = useFieldDraft(displayed);
  return <input id={props.id} className={props.className} aria-describedby={props['aria-describedby']} aria-label={props.label} type="number" min={props.min} max={props.max} step={props.step ?? 1} value={draft.shown} disabled={props.disabled}
    onFocus={draft.begin}
    onChange={(event) => draft.type(event.currentTarget.value)}
    onInput={(event) => event.currentTarget.setCustomValidity('')}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { event.currentTarget.value = displayed; event.currentTarget.setCustomValidity(''); }
      event.currentTarget.blur();
    }}
    onBlur={(event) => {
      const input = event.currentTarget;
      // Leaving the field shows the project's value again: the committed one, or the old one when refused.
      draft.end();
      const next = input.valueAsNumber;
      if (input.value === displayed || next === props.value) return;
      if (!input.value.trim() || !Number.isFinite(next) || !input.validity.valid) {
        const message = input.validationMessage || '请输入有效数值';
        input.value = displayed; input.setCustomValidity(message); input.reportValidity(); return;
      }
      try { if (props.onCommit(next) === false) input.value = displayed; }
      catch (error) {
        input.value = displayed;
        input.setCustomValidity(error instanceof Error ? error.message : String(error)); input.reportValidity();
      }
    }} />;
}
