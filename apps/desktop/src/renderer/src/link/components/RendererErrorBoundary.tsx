import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Activity } from 'lucide-react';

export class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { console.error('Renderer crashed', error, info); }
  override render(): ReactNode {
    if (this.state.error) return <div className="fatal-screen"><Activity /><h1>界面暂时无法显示</h1><p>请重新打开联动台恢复界面，已保存的工程不会受影响。</p></div>;
    return this.props.children;
  }
}
