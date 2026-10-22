import { consoleLabelText } from '@tb/core/link';
import '../ma2-layout.css';

/** The text MA2 will show for a name typed here; nothing when the console shows the name unchanged. */
export function Ma2ConsoleName({ name }: { name: string }): JSX.Element | null {
  const text = consoleLabelText(name);
  if (text === name.trim()) return null;
  return <small className="ma2-console-name">{text ? `控台显示为：${text}` : '控台无法显示这个名称，请加入中文、英文或数字'}</small>;
}
