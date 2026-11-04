import { Download, FilePlus2, FolderOpen, ListMusic } from 'lucide-react';
import { Button } from '../ui';

const steps = [
  ['添加歌曲', '一次导入多首音乐，建立演出节目单。'],
  ['编排画面与灯光', '在 Cue 编辑器添加素材，安排每个时间点。'],
  ['点击播放', '在同一页切歌、暂停和连播，也可选择跟随 P1。']
] as const;

/** The home page before a project is open: what the software is for and the three ways in. */
export function ProjectWelcome({ onCreate, onOpen, onImportSongs }: { onCreate: () => void; onOpen: () => void; onImportSongs: () => void }): JSX.Element {
  return <section className="home-welcome" aria-labelledby="home-welcome-title">
    <span className="home-welcome-icon" aria-hidden="true"><ListMusic /></span>
    <div className="home-welcome-copy">
      <h1 id="home-welcome-title">从一份节目单开始</h1>
      <p>把音乐、画面和灯光编排在一起。演出时，点击歌曲即可运行整条时间线。</p>
    </div>
    <div className="home-welcome-actions">
      <Button variant="primary" icon={Download} onClick={onImportSongs}>导入歌曲 / P1</Button>
      <Button variant="secondary" icon={FilePlus2} onClick={onCreate}>新建工程</Button>
      <Button variant="secondary" icon={FolderOpen} onClick={onOpen}>打开工程</Button>
    </div>
    <ol className="home-welcome-steps">
      {steps.map(([title, text], index) => <li key={title}><span>{String(index + 1).padStart(2, '0')}</span><strong>{title}</strong><p>{text}</p></li>)}
    </ol>
  </section>;
}
