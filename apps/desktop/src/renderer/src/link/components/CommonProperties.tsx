import type { LightingDocument, RundownItem } from '@tb/schema';
import { LightingArrangementSettings } from './LightingArrangementSettings';
import { SongPlaybackProperties } from './SongPlaybackProperties';

type Props = {
  item: RundownItem;
  document: LightingDocument;
  disabled: boolean;
  onChange: (document: LightingDocument, label: string) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
};

export function CommonProperties({ item, document, disabled, onChange, notify }: Props): JSX.Element {
  return <div className="common-properties">
    <div className="common-properties-program"><span>常用</span><strong title={item.title}>{item.title}</strong></div>
    <fieldset className="common-properties-fields" disabled={disabled}>
      <section className="arrangement-property-group" aria-label="节拍与循环"><h3>节拍 / 循环</h3><LightingArrangementSettings document={document} onChange={onChange} /></section>
      <section className="song-properties" aria-label="歌曲播放"><h3>歌曲播放</h3><SongPlaybackProperties collapseAdvanced item={item} notify={notify} /></section>
    </fieldset>
    {disabled ? <p role="status">停止播放后可修改设置</p> : null}
  </div>;
}
