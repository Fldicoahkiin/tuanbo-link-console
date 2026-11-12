import type { ReactNode } from 'react';
import { Command, LogOut } from 'lucide-react';
import type { ConsoleRole } from '../../src/console-contract';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { roleNames } from '../forms';
import { cn } from '../lib/utils';
import { navigationGroups, type NavItem } from '../navigation';

type SidebarProps = {
  items: NavItem[];
  route: string;
  username: string;
  role: ConsoleRole;
  busy: boolean;
  navigate: (key: string) => void;
  logout: () => void;
  /** 只在手机抽屉里有：二次验证状态放在账号上面。 */
  extra?: ReactNode;
};

/** 侧栏内容：品牌、分组导航、账号和退出。桌面固定在左边，手机放在抽屉里。 */
export function SidebarBody({ items, route, username, role, busy, navigate, logout, extra }: SidebarProps) {
  return <div className="flex h-full min-h-0 flex-col">
    <button type="button" onClick={() => navigate('overview')}
      className={cn('hover:bg-accent focus-visible:ring-ring/50 mx-3 mt-3 flex items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-3', extra && 'mr-14')}>
      <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg"><Command className="size-4" aria-hidden="true" /></span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">团播联动台</span>
        <span className="text-muted-foreground text-xs">运营管理</span>
      </span>
    </button>
    <nav aria-label="后台导航" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
      {navigationGroups.map(group => {
        const entries = items.filter(item => group.keys.includes(item.key));
        if (!entries.length) return null;
        return <div key={group.label} className="flex flex-col gap-0.5">
          <p className="text-muted-foreground px-2 pb-1 text-xs">{group.label}</p>
          {entries.map(item => <button key={item.key} type="button" aria-current={route === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}
            className={cn('focus-visible:ring-ring/50 flex h-9 items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none focus-visible:ring-3',
              route === item.key ? 'bg-accent text-foreground font-medium' : 'text-sidebar-foreground hover:bg-accent')}>
            <item.icon className="size-4 shrink-0" aria-hidden="true" />
            {item.title}
          </button>)}
        </div>;
      })}
    </nav>
    {extra && <div className="px-5 pb-3 text-xs">{extra}</div>}
    <div className="flex items-center gap-2.5 border-t px-5 py-3">
      <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-medium" aria-hidden="true">
        {username.slice(0, 1).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{username}</span>
        <span className="text-muted-foreground text-xs">{roleNames[role]}</span>
      </span>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon" className="max-lg:size-9" aria-label="退出登录" disabled={busy} onClick={logout} />}>
          <LogOut aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>退出登录</TooltipContent>
      </Tooltip>
    </div>
  </div>;
}
