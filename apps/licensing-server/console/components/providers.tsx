import type { ReactNode } from 'react';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { Toast } from '@base-ui/react/toast';
import { TooltipProvider } from './ui/tooltip';
import { Toaster, toastManager } from './toaster';

/**
 * 整个后台包在这一层里。
 * CSPProvider：线上的 CSP 是 style-src 'self'，Base UI 不能在运行时插 <style>；它需要的两条规则写在 styles.css 里。
 */
export function Providers({ children }: { children: ReactNode }) {
  return <CSPProvider disableStyleElements>
    <Toast.Provider toastManager={toastManager} timeout={4000} limit={4}>
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster />
    </Toast.Provider>
  </CSPProvider>;
}
