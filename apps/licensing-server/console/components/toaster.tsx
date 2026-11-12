import { Toast } from '@base-ui/react/toast';
import { CircleAlert, CircleCheck, X } from 'lucide-react';

/** 全后台共用一个提示队列，组件外也能发（notify.success / notify.error）。 */
export const toastManager = Toast.createToastManager();

/** 操作结果的轻提示。成功的 4 秒后自己消失；失败的留着，等人看过再点掉。要人做决定、或带激活码的结果不用它，留在对话框里。 */
export const notify = {
  success: (title: string, description?: string): void => { toastManager.add({ title, type: 'success', ...(description ? { description } : {}) }); },
  error: (title: string, description?: string): void => { toastManager.add({ title, type: 'error', timeout: 0, priority: 'high', ...(description ? { description } : {}) }); }
};

/** 右下角的提示列表，放在 Providers 里，整个后台只渲染一次。 */
export function Toaster() {
  const { toasts } = Toast.useToastManager();
  return <Toast.Portal>
    <Toast.Viewport className="fixed right-4 bottom-4 z-60 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
      {toasts.map(toast => <Toast.Root key={toast.id} toast={toast} swipeDirection="right"
        className="bg-popover text-popover-foreground ring-foreground/10 flex items-start gap-2.5 rounded-lg p-3 text-sm shadow-md ring-1 transition-[opacity,translate] duration-200 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-[swipe-direction=right]:data-ending-style:translate-x-full">
        {toast.type === 'error' ? <CircleAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <CircleCheck className="text-success mt-0.5 size-4 shrink-0" aria-hidden="true" />}
        <Toast.Content className="grid min-w-0 flex-1 gap-0.5">
          <Toast.Title className="font-medium" />
          <Toast.Description className="text-muted-foreground break-words" />
        </Toast.Content>
        <Toast.Close aria-label="关闭提示" className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -m-1 rounded-md p-1 outline-none focus-visible:ring-3"><X className="size-4" aria-hidden="true" /></Toast.Close>
      </Toast.Root>)}
    </Toast.Viewport>
  </Toast.Portal>;
}
