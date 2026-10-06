import { Button } from './Button';
import { ListMusic, FilePlus2, FolderOpen, Download } from 'lucide-react';
export function ProjectWelcome({ onCreate, onOpen, onImportSongs }: { onCreate: () => void; onOpen: () => void; onImportSongs: () => void }): JSX.Element {
  return <section className="project-welcome"><ListMusic />
    <div><h1>从一份节目单开始</h1><p>把音乐、画面和灯光编排在一起。演出时，点击歌曲即可运行整条时间线。</p></div>
    <div className="project-welcome-actions"><Button className="primary-button" onClick={onImportSongs}><Download />导入歌曲 / P1</Button><Button className="secondary-button" onClick={onCreate}><FilePlus2 />新建工程</Button><Button className="secondary-button" onClick={onOpen}><FolderOpen />打开工程</Button></div>
    <div className="project-welcome-steps"><div><span>01</span><strong>添加歌曲</strong><p>一次导入多首音乐，建立演出节目单。</p></div><div><span>02</span><strong>编排画面与灯光</strong><p>在 Cue 编辑器添加素材，安排每个时间点。</p></div><div><span>03</span><strong>点击播放</strong><p>在同一页切歌、暂停和连播，也可选择跟随 P1。</p></div></div>
  </section>;
}
