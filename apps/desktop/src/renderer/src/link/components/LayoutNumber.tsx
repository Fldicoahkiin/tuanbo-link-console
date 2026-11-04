import { WithUnit } from '../ui';
import { PropertyNumberInput } from './PropertyNumberInput';

/** One number of a picture's layout on the canvas (position, size, rotation, crop), with its unit. */
export function LayoutNumber(props: { label: string; unit: string; value: number; onCommit: (value: number) => void }): JSX.Element {
  return <label className="layout-number"><span>{props.label}</span><WithUnit unit={props.unit}><PropertyNumberInput className="ui-input" label={props.label} value={props.value} step={0.01} precision={2} onCommit={props.onCommit} /></WithUnit></label>;
}
