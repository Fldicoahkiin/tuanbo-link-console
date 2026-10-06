/** Optional adapters are cancelled at the deadline; late completion never enables this session. */
export function optionalOutputReady<T>(operation: Promise<T>, cancel: () => void, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        cancel();
        reject(new Error(`${label}在本次播放准备窗口内未就绪，已取消；请检查设备后重新联动`));
      } catch (error) {
        reject(new Error(`${label}准备超时，取消清理失败：${error instanceof Error ? error.message : String(error)}；本轮未参与，请检查设备后重新联动`, { cause: error }));
      }
    }, 1000);
    operation.then(value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } }, error => { if (!settled) { settled = true; clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); } });
  });
}
