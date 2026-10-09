import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';
import { suspendProjectReopen } from '../stores/project-recovery';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

export class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; recovering: boolean; recoveryError: string }> {
  override state = { error: null as Error | null, recovering: false, recoveryError: '' };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer crashed', error, info);
    try { suspendProjectReopen(useDocumentStore.getState().path); }
    catch (failure) { this.setState({ recoveryError: `暂停自动打开失败：${String(failure)}` }); }
    void desktop.recordLog({ level: 'error', category: 'system', device: 'Electron', result: 'failed', message: `工作区显示异常：${error.message}`.slice(0, 8192),
      details: { stack: error.stack?.slice(0, 32768) ?? '', componentStack: info.componentStack?.slice(0, 32768) ?? '' }
    }).catch((failure: unknown) => { console.error('无法保存界面错误日志', failure); this.setState({ recoveryError: `错误日志保存失败：${String(failure)}` }); });
  }
  private recover = async (): Promise<void> => {
    this.setState({ recovering: true, recoveryError: '' });
    try {
      const current = useDocumentStore.getState();
      suspendProjectReopen(current.path);
      // Never discard an unsaved in-memory edit when offering a fresh workspace.
      if (current.dirty && current.project) {
        const backup = await desktop.saveProject(null, current.project);
        if (!backup) { this.setState({ recovering: false }); return; }
      }
      window.location.reload();
    } catch (failure) { this.setState({ recovering: false, recoveryError: `恢复失败：${String(failure)}` }); }
  };
  override render(): ReactNode {
    if (this.state.error) return <div className="fatal-screen"><Activity /><h1>界面暂时无法显示</h1>
      <p>工程文件保留在原位置。重新进入后将暂停自动打开该工程；如有未保存修改，会先请你另存备份。</p>
      <pre>{this.state.error.message}</pre>
      <button type="button" disabled={this.state.recovering} onClick={() => void this.recover()}>重新进入工作区</button>
      {this.state.recoveryError ? <p role="alert">{this.state.recoveryError}</p> : null}</div>;
    return this.props.children;
  }
}
