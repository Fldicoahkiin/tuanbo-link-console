import {
  CircleAlert,
  ClipboardList,
  CloudUpload,
  History,
  KeyRound,
  LayoutDashboard,
  MessageSquareWarning,
  MessagesSquare,
  Receipt,
  ShieldCheck,
  Users,
  type LucideIcon
} from 'lucide-react';
import { feedbackRoles, type ConsoleRole } from '../src/console-contract';
import { actionNames } from './forms';

export type NavItem = { key: string; title: string; icon: LucideIcon };

/** 后台的全部入口，顺序就是侧栏里的顺序。 */
export const navigation: NavItem[] = [
  { key: 'overview', title: '工作台', icon: LayoutDashboard },
  { key: 'orders', title: '订单中心', icon: ClipboardList },
  { key: 'licenses', title: '激活码与设备', icon: KeyRound },
  { key: 'exceptions', title: '交付异常', icon: CircleAlert },
  { key: 'tickets', title: '售后工单', icon: MessagesSquare },
  { key: 'feedback', title: '问题反馈', icon: MessageSquareWarning },
  { key: 'finance', title: '财务记录', icon: Receipt },
  { key: 'audit', title: '操作日志', icon: History },
  { key: 'users', title: '人员管理', icon: Users },
  { key: 'updates', title: '软件更新', icon: CloudUpload },
  { key: 'security', title: '安全设置', icon: ShieldCheck }
];

/** 侧栏分组：小号灰色的组名下面是这一组的入口。 */
export const navigationGroups: { label: string; keys: string[] }[] = [
  { label: '业务', keys: ['overview', 'orders', 'licenses', 'exceptions', 'tickets', 'feedback', 'finance'] },
  { label: '管理', keys: ['audit', 'users', 'updates', 'security'] }
];

/** 各角色能看到的入口：人员、日志、更新只给管理员；财务给管理员和财务；反馈给 feedbackRoles。 */
export function visibleNavigation(role: ConsoleRole): NavItem[] {
  return navigation
    .filter(item => !['users', 'audit', 'updates'].includes(item.key) || role === 'owner')
    .filter(item => item.key !== 'finance' || ['owner', 'finance'].includes(role))
    .filter(item => item.key !== 'feedback' || feedbackRoles.includes(role));
}

/** 有说明的页面，在页面最上面显示这一句。 */
export const pageNotes: Record<string, string> = {
  exceptions: '已收款未交付，或渠道退款后待决定授权去留的订单。',
  feedback: '客户在软件「设置 › 帮助与反馈」或激活页提交的现象说明。诊断包保存 180 天，记录保存两年。'
};

/** 各列表显示的列。 */
export const columns: Record<string, string[]> = {
  orders: ['reference', 'customer', 'channel', 'amountFen', 'paymentStatus', 'state', 'created'],
  exceptions: ['reference', 'customer', 'channel', 'amountFen', 'state', 'deliveryError', 'channelRefundFen', 'reviewedRefundFen'],
  licenses: ['customer', 'status', 'source', 'useUntil', 'machineCode'],
  tickets: ['orderReference', 'category', 'state', 'note', 'created'],
  feedback: ['number', 'category', 'state', 'summary', 'attachment', 'version', 'created'],
  finance: ['orderId', 'category', 'amountFen', 'reference', 'state', 'created'],
  audit: ['at', 'operator', 'action', 'targetLabel', 'result', 'reason'],
  users: ['username', 'role', 'status']
};

/** 列表的状态 / 类别 / 操作筛选。 */
export const stateFilters: Record<string, { label: string; options: [string, string][] }> = {
  orders: { label: '状态', options: [['pending', '待付款'], ['paid', '已收款待交付'], ['fulfilled', '已交付'], ['refunded', '已全额退款'], ['closed', '已关闭'], ['expired', '已过期']] },
  tickets: { label: '状态', options: [['active', '未关闭'], ['open', '待处理'], ['processing', '处理中'], ['closed', '已关闭']] },
  feedback: { label: '状态', options: [['active', '未关闭'], ['open', '待处理'], ['processing', '处理中'], ['closed', '已关闭']] },
  finance: { label: '类别', options: [['refund', '退款'], ['invoice', '开票']] },
  audit: { label: '操作', options: Object.entries(actionNames) }
};

/** 订单列表的来源筛选。 */
export const channelOptions = ['manual', 'alipay', 'wechat', 'test', 'gift'];

/** 授权生命周期页签，状态定义与服务端 licenseRows 一致；计数来自列表 summary。 */
export const lifecycle: [string, string][] = [['', '全部'], ['active', '生效中'], ['unbound', '未激活'], ['expiring', '即将到期'], ['expired', '已过期'], ['revoked', '已撤销']];

/** 搜索框的占位文字。 */
export function searchPlaceholder(route: string): string {
  if (route === 'audit') return '对象、操作人或原因';
  if (route === 'feedback') return '反馈编号、现象、联系方式或机器码';
  return '编号、客户或相关记录';
}

/** 工作台的待办：哪个数字、点了去哪、带什么筛选。 */
export const overviewTasks: { key: string; route: string; title: string; hint?: string; preset: Record<string, string> }[] = [
  { key: 'pendingOrders', route: 'orders', title: '待付款与核款', preset: { state: 'pending' } },
  { key: 'deliveryPending', route: 'exceptions', title: '待完成交付', preset: {} },
  { key: 'refundReview', route: 'exceptions', title: '渠道退款待处理', hint: '决定撤销或保留授权', preset: {} },
  { key: 'openTickets', route: 'tickets', title: '待处理售后', preset: { state: 'active' } },
  { key: 'openFeedback', route: 'feedback', title: '待处理问题反馈', hint: '客户在软件里提交的现象和诊断包', preset: { state: 'active' } },
  { key: 'expiring', route: 'licenses', title: '七日内到期', preset: { state: 'expiring' } }
];
