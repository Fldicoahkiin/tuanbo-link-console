import { ObsPluginInstallError } from './obs-live-install';

type ProcessState = { pid: number | null; owned: boolean };
export type ObsBridgeSetupTools = {
  install(allowElevation: boolean): Promise<boolean>;
  process(): Promise<ProcessState>;
  confirm(kind: 'restart' | 'external', reason: string): Promise<boolean>;
  stop(): Promise<void>;
  start(): Promise<void>;
  connect(): Promise<void>;
  verify(): Promise<void>;
};

/** Explicit setup transaction. No background retries or process ownership bypass. */
export class ObsBridgeSetup {
  private operation: Promise<void> | null = null;
  constructor(private readonly tools: ObsBridgeSetupTools) {}

  prepare(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const changed = await this.tools.install(false);
        if (changed) {
          const process = await this.tools.process();
          if (process.pid !== null) await this.release(process, '组件已安装，需要重启 OBS 才能加载。');
        }
      }
      catch (error) {
        if (!(error instanceof ObsPluginInstallError)) throw error;
        const process = await this.tools.process();
        if (process.pid !== null) await this.release(process, error.message);
        await this.tools.install(true);
      }
    });
  }

  repair(): Promise<void> {
    return this.exclusive(async () => {
      const process = await this.tools.process();
      if (process.pid === null) {
        await this.tools.install(true);
      } else {
        let reason = '组件文件已更新，需要重新启动 OBS 加载新组件。';
        let changed = true;
        try {
          changed = await this.tools.install(false);
        } catch (error) {
          if (!(error instanceof ObsPluginInstallError)) throw error;
          reason = error instanceof Error ? error.message : String(error);
        }
        if (!changed) {
          // Authentication and network failures are not plugin failures.
          await this.tools.connect();
          try { await this.tools.verify(); return; }
          catch (error) { reason = error instanceof Error ? error.message : String(error); }
        }
        await this.release(process, reason);
        await this.tools.install(true);
      }
      await this.tools.start();
      await this.tools.connect();
      await this.tools.verify();
    });
  }

  private async release(process: ProcessState, reason: string): Promise<void> {
    if (!await this.tools.confirm(process.owned ? 'restart' : 'external', reason)) throw new Error('已取消修复 OBS 组件，正在运行的 OBS 没有变动');
    if (process.owned) {
      const current = await this.tools.process();
      if (!current.owned || current.pid !== process.pid) throw new Error('OBS 进程已变化，请重新检查组件');
      // The process adapter checks streaming/recording immediately before normal close.
      await this.tools.stop();
    } else if ((await this.tools.process()).pid !== null) {
      throw new Error('OBS 还在运行。请先正常退出 OBS，再点一次“检查并修复组件”（联动台不会强制关闭它）。');
    }
  }

  private exclusive(action: () => Promise<void>): Promise<void> {
    if (this.operation) return Promise.reject(new Error('正在修复 OBS 组件，请稍等'));
    this.operation = action().finally(() => { this.operation = null; });
    return this.operation;
  }
}
