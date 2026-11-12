import { useState, type ReactNode } from 'react';
import { Menu, RefreshCw, X } from 'lucide-react';
import type { ConsoleRole } from '../../src/console-contract';
import { Button } from '../components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '../components/ui/sheet';
import { cn } from '../lib/utils';
import type { NavItem } from '../navigation';
import { SidebarBody } from './sidebar';

type ShellProps = {
  items: NavItem[];
  route: string;
  title: string;
  username: string;
  role: ConsoleRole;
  busy: boolean;
  navigate: (key: string) => void;
  logout: () => void;
  reload: () => void;
  /** 二次验证状态（StepUpBadge）：桌面在顶栏，手机在抽屉里。 */
  stepUp: ReactNode;
  children: ReactNode;
};

/** 后台外壳：桌面左边固定侧栏、右边顶栏加内容；窄屏侧栏收进左边出来的抽屉。 */
export function AppShell({ items, route, title, username, role, busy, navigate, logout, reload, stepUp, children }: ShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sidebar = { items, route, username, role, busy, logout };
  return <div className="bg-background text-foreground min-h-svh lg:pl-58">
    <aside className="bg-sidebar fixed inset-y-0 left-0 z-30 hidden w-58 border-r lg:block">
      <SidebarBody {...sidebar} navigate={navigate} />
    </aside>
    <div className="flex min-w-0 flex-col">
      <header className="bg-background sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 lg:px-6">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger render={<Button variant="ghost" size="icon" className="-ml-2 size-9 lg:hidden" aria-label="打开导航" />}>
            <Menu aria-hidden="true" />
          </SheetTrigger>
          <SheetContent side="left" showCloseButton={false} className="bg-sidebar w-72 gap-0 p-0">
            <SheetTitle className="sr-only">后台导航</SheetTitle>
            <SheetClose render={<Button variant="ghost" size="icon" className="absolute top-3.5 right-3 size-9" aria-label="关闭导航" />}>
              <X aria-hidden="true" />
            </SheetClose>
            <SidebarBody {...sidebar} extra={stepUp} navigate={key => { setMenuOpen(false); navigate(key); }} />
          </SheetContent>
        </Sheet>
        <h1 className="min-w-0 flex-1 truncate text-lg font-medium">{title}</h1>
        <div className="hidden items-center text-xs lg:flex">{stepUp}</div>
        <Button variant="outline" size="sm" className="max-lg:size-9 max-lg:px-0" aria-label="刷新当前页面" title="刷新当前页面" disabled={busy} onClick={reload}>
          <RefreshCw className={cn(busy && 'animate-spin')} aria-hidden="true" />
          <span className="max-lg:hidden">刷新</span>
        </Button>
      </header>
      <main aria-label={title} className="w-full max-w-6xl min-w-0 px-4 py-6 lg:px-6">{children}</main>
    </div>
  </div>;
}
