import { consolePolicy } from '../../src/console-contract';
import { PageCard } from '../components/page-card';
import { beijingTime, roleNames } from '../forms';
import { StepUpPrompt, stepUpMinutes } from '../step-up';
import type { Session } from '../console-app';

const days = (ms: number) => Math.round(ms / 86400000);

/** 安全设置：立即二次验证、最近验证时间、登录保持多久。 */
export function SecurityPage({ session, reloadSession }: { session: Session; reloadSession: () => void }) {
  return <div className="flex flex-col gap-6">
    <PageCard title="二次验证" contentClassName="flex flex-col gap-4">
      <StepUpPrompt key={session.verifiedAt} csrf={session.csrf} title="立即验证"
        hint={`每枚验证码只能用一次；验证后 ${stepUpMinutes} 分钟内的敏感操作无需再输。`} onVerified={reloadSession} />
      <p className="text-sm">最近验证：<span className="tabular-nums">{beijingTime(session.verifiedAt)}</span></p>
      <p className="text-muted-foreground text-sm">修改密码或更换验证器：由另一名管理员执行“重置人员认证”后重新开通。</p>
    </PageCard>
    <PageCard title="登录" contentClassName="flex flex-col gap-4">
      <p className="text-sm">登录后 {days(consolePolicy.sessionIdleMs)} 天不用会自动退出，最长保持 {days(consolePolicy.sessionMaxMs)} 天。</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-xs">当前账号</dt>
          <dd className="text-sm break-all">{session.user.username}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-xs">角色</dt>
          <dd className="text-sm">{roleNames[session.user.role]}</dd>
        </div>
      </dl>
    </PageCard>
  </div>;
}
