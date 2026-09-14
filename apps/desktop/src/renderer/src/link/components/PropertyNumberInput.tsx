/** Commit a complete numeric edit; empty or invalid drafts never change the project. */
export function PropertyNumberInput(props: {
  value: number;
  onCommit: (value: number) => void | boolean;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  disabled?: boolean;
}): JSX.Element {
  const displayed = props.precision === undefined ? String(props.value) : String(Number(props.value.toFixed(props.precision)));
  return <input key={props.value} aria-label={props.label} type="number" min={props.min} max={props.max} step={props.step ?? 1} defaultValue={displayed} disabled={props.disabled}
    onInput={(event) => event.currentTarget.setCustomValidity('')}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { event.currentTarget.value = displayed; event.currentTarget.setCustomValidity(''); }
      event.currentTarget.blur();
    }}
    onBlur={(event) => {
      const input = event.currentTarget;
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
