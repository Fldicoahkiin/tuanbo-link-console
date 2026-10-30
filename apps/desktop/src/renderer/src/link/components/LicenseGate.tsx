import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, AudioLines, Clapperboard, KeyRound, Maximize2, MessageSquareWarning, Minus, PanelsTopLeft, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { FeedbackForm } from './FeedbackSettings';
import { ModalSurface } from '../ui/ModalSurface';
import { LicenseSettings } from './LicenseSettings';
import { UpdateCenter } from './UpdateCenter';
import timelinePreview from '../../assets/activation-timeline.webp';

/** Before activation no project is open; the main process adds the machine, license and logs. */
const gateContext = (): Record<string, unknown> => ({ project: null, page: '激活页' });

/** Do not mount device adapters or restore a project before main-process authorization. */
export function LicenseGate({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<'checking' | 'locked' | 'authorized'>('checking');
  const [error, setError] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The update panel shows its own status and failures in place.
  const updateNotice = useCallback(() => undefined, []);
  const controlWindow = async (action: 'minimize' | 'toggleMaximize' | 'close'): Promise<void> => {
    try { await window.tbLink.controlWindow(action); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  useEffect(() => {
    let alive = true;
    void window.tbLink.requireOutputLicense().then(() => {
      if (alive) setState('authorized');
    }, (failure: unknown) => {
      if (alive) { setError(failure instanceof Error ? failure.message : String(failure)); setState('locked'); }
    });
    return () => { alive = false; };
  }, []);
  if (state === 'authorized') return <>{children}</>;
  return <div className="license-gate">
    <header className="license-titlebar" aria-label="窗口标题栏">
      <div className="license-window-brand"><PanelsTopLeft aria-hidden="true" /><strong>团播联动台</strong><span>产品授权</span></div>
      <div className="license-drag-space" title="拖动窗口，双击最大化或还原" aria-hidden="true" />
      <div className="license-window-controls" aria-label="窗口控制">
        <Button aria-label="最小化窗口" title="最小化" onClick={() => void controlWindow('minimize')}><Minus /></Button>
        <Button aria-label="最大化或还原窗口" title="最大化或还原" onClick={() => void controlWindow('toggleMaximize')}><Maximize2 /></Button>
        <Button className="license-window-close" aria-label="关闭软件" title="关闭" onClick={() => void controlWindow('close')}><X /></Button>
      </div>
    </header>
    <main className="license-page-scroll">
      <div className="license-onboarding">
        <aside className="license-introduction">
          <p className="license-eyebrow"><span />为团播现场而做 · WINDOWS</p>
          <h1>一张节目单，<br /><span>联动整场演出。</span></h1>
          <p className="license-intro-copy">把音乐、画面与灯光排进同一条时间线。<br />提前编排，现场从容切换。</p>
          <div className="license-product-actions">
            <a className="license-purchase-link" href="https://tuanbo-link.jinhefilm.com/#purchase" target="_blank" rel="noreferrer">购买授权<ArrowUpRight aria-hidden="true" /></a>
            <a className="license-website-link" href="https://tuanbo-link.jinhefilm.com/" target="_blank" rel="noreferrer">官网了解产品<ArrowUpRight aria-hidden="true" /></a>
          </div>
          <p className="license-purchase-note">官网查看价格与方案 · 已购买可在右侧直接激活</p>
          <figure className="license-product-preview">
            <img src={timelinePreview} width={1440} height={900} alt="团播联动台真实界面：音乐波形、画面片段与灯光 Cue 在时间线上编排" />
            <figcaption><span><Clapperboard aria-hidden="true" />节目编排</span><span><AudioLines aria-hidden="true" />音乐与画面</span><span>OBS · MIDI · P1</span></figcaption>
          </figure>
        </aside>
        <div className="license-activation-card">
          <div className="license-card-welcome"><div className="license-card-icon"><KeyRound aria-hidden="true" /></div><p>你的下一场演出，从这里开始</p></div>
          {state === 'checking' ? <div className="license-checking" role="status"><KeyRound aria-hidden="true" /><h2>正在验证本机授权</h2><p>验证完成后进入工作区，请稍候…</p></div> : <>
            <LicenseSettings runtimeActive={false} onAuthorized={async () => {
              await window.tbLink.requireOutputLicense();
              setState('authorized');
            }} />
            {error ? <p className="license-startup-message" role="alert">{error}</p> : null}
            <section className="license-gate-help" aria-label="遇到问题">
              <div><strong>激活或更新遇到问题？</strong><span>写下看到的现象，连同诊断信息发给售后。没有网络时可以另存为文件。</span></div>
              <Button className="secondary-button" onClick={() => setFeedbackOpen(true)}><MessageSquareWarning />问题反馈</Button>
            </section>
            <section className="license-gate-update" aria-label="软件更新"><UpdateCenter inline notify={updateNotice} /></section>
          </>}
        </div>
      </div>
    </main>
    {feedbackOpen ? <ModalSurface label="问题反馈" className="device-console feedback-dialog" onClose={() => setFeedbackOpen(false)}>
      <header className="feedback-dialog-header"><h2>问题反馈</h2><Button aria-label="关闭问题反馈" title="关闭" onClick={() => setFeedbackOpen(false)}><X /></Button></header>
      <FeedbackForm compact initialCategory="license" context={gateContext} ma2Available={false} />
    </ModalSurface> : null}
    <footer className="license-footer"><span>团播联动台 / TUANBO LINK CONSOLE</span><div className="license-footer-links">
      <button type="button" onClick={() => setFeedbackOpen(true)}><MessageSquareWarning aria-hidden="true" />提交问题反馈</button>
      <a href="https://tuanbo-link.jinhefilm.com/#contact" target="_blank" rel="noreferrer">购买咨询与售后<ArrowUpRight aria-hidden="true" /></a>
    </div></footer>
  </div>;
}
