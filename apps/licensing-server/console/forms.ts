import type { ConsoleAction } from '../src/console-contract';
export type Field = { key: string; label: string; type?: 'number' | 'datetime-local' | 'textarea' | 'select'; options?: readonly [string, string][]; optional?: boolean };
const reason: Field = { key: 'reason', label: '操作原因', type: 'textarea' };
const customer: Field[] = [{ key: 'customer', label: '客户名称' }, { key: 'customerType', label: '客户类型', type: 'select', options: [['company', '企业'], ['personal', '个人']] }, { key: 'quantity', label: '授权数量（1–100）', type: 'number' }, { key: 'useUntil', label: '授权截止时间（北京时间）', type: 'datetime-local' }];
const amount: Field = { key: 'amountFen', label: '金额（元）', type: 'number' };
const roles: [string, string][] = [['owner', '管理员'], ['operations', '运营'], ['finance', '财务'], ['viewer', '只读']];
export const roleNames = Object.fromEntries(roles);
export const forms: Record<ConsoleAction['action'], { title: string; note?: string; fields: Field[] }> = {
  'create-order': { title: '创建线下订单', fields: [{ key: 'reference', label: '业务订单编号' }, ...customer, amount, reason] },
  fulfill: { title: '确认实际收款并发码', note: '核实到账后提交，提交即发码。', fields: [amount, { key: 'paymentReference', label: '真实收款流水号' }, { key: 'paymentMethod', label: '付款方式' }, reason] },
  reconcile: { title: '向支付渠道查单', note: '已过付款期限仍未付款的支付宝订单会被关闭。', fields: [reason] },
  'payment-link': { title: '生成支付宝付款链接', note: '15 分钟内有效。生成后只能经支付宝收款，过期未付需查单后重新建单。', fields: [reason] },
  'close-order': { title: '关闭订单', note: '关闭后不能再核款发码。', fields: [reason] },
  'retry-delivery': { title: '补交付', fields: [reason] },
  'delivery-access': { title: '重发领取凭据', note: '原领取凭据立即失效。', fields: [reason] },
  'revoke-delivery-access': { title: '撤销领取凭据', note: '不影响已签发的授权。', fields: [reason] },
  reveal: { title: '查看完整激活码', fields: [reason] },
  'set-expiry': { title: '调整到期时间', note: '只改这一个激活码，下次联网验证时生效。永久码设定后变为期限授权。', fields: [{ key: 'useUntil', label: '新的到期时间（北京时间）', type: 'datetime-local' }, reason] },
  revoke: { title: '撤销授权', note: '已运行的会话不会立即停止，也不会退款。', fields: [reason] },
  migrate: { title: '办理换机', note: '最后凭证到期 5 分钟后可办理，旧码随即失效。', fields: [reason] },
  grant: { title: '签发特殊授权', note: '不计入收款。', fields: [...customer, { key: 'purpose', label: '授权用途', type: 'select', options: [['test', '内测'], ['gift', '赠送']] }, reason] },
  'create-user': { title: '添加人员', note: '开通凭据 24 小时内有效。', fields: [{ key: 'username', label: '用户名（英文、数字、点、横线）' }, { key: 'role', label: '角色', type: 'select', options: roles }, reason] },
  'update-user': { title: '修改人员权限', note: '保存后该人员需重新登录。', fields: [{ key: 'role', label: '角色', type: 'select', options: roles }, { key: 'enabled', label: '账号状态', type: 'select', options: [['true', '启用'], ['false', '禁用']] }, reason] },
  'reset-user': { title: '重置人员认证', note: '原密码和验证器失效，需重新开通。', fields: [reason] },
  'create-ticket': { title: '创建售后工单', fields: [{ key: 'licenseId', label: '授权 ID（可选）', optional: true }, { key: 'category', label: '问题类别', type: 'select', options: [['migration', '换机'], ['refund', '退款'], ['invoice', '开票'], ['recovery', '订单找回'], ['other', '其他']] }, { key: 'note', label: '问题描述', type: 'textarea' }, reason] },
  'update-ticket': { title: '处理工单', note: '关闭时须填写授权处理结论。', fields: [{ key: 'state', label: '处理状态', type: 'select', options: [['processing', '处理中'], ['closed', '关闭'], ['open', '待处理']] }, { key: 'conclusion', label: '授权处理结论', type: 'textarea', optional: true }, reason] },
  refund: { title: '登记已办理的退款', note: '仅记账，不会退款，也不会撤销授权。', fields: [amount, { key: 'reference', label: '退款渠道凭证编号' }, { key: 'handledAt', label: '实际办理时间（北京时间）', type: 'datetime-local' }, reason] },
  'alipay-refund': { title: '支付宝原路退款', note: '全额退款会撤销本订单全部授权；部分退款和续费订单退款进入交付异常。结果未确认时，按相同金额重新提交不会重复退款。', fields: [amount, { key: 'reason', label: '退款原因（买家可见，最多 256 字）', type: 'textarea' }] },
  'refund-review': { title: '处理渠道退款', note: '续费订单只能保留，需先用“调整到期时间”回退续期。', fields: [{ key: 'decision', label: '处理方式', type: 'select', options: [['revoke', '撤销本订单全部授权'], ['keep', '保留授权，仅结案']] }, reason] },
  invoice: { title: '记录开票进度', note: '仅记录进度，不开具发票。', fields: [{ key: 'state', label: '办理状态', type: 'select', options: [['requested', '已申请'], ['processing', '办理中'], ['issued', '已开票'], ['rejected', '无法办理']] }, { key: 'buyer', label: '购买方抬头' }, { key: 'taxId', label: '税号（可选）', optional: true }, { key: 'reference', label: '发票编号（已开票必填）', optional: true }, reason] }
};
/** Irreversible or credential-invalidating actions: red styling and a confirm label that names the consequence. */
export const destructiveActions: Partial<Record<ConsoleAction['action'], string>> = {
  revoke: '确认撤销授权', 'revoke-delivery-access': '确认撤销领取凭据', 'delivery-access': '确认重发（原凭据失效）',
  'alipay-refund': '确认向支付宝发起退款', 'refund-review': '确认处理渠道退款', 'reset-user': '确认重置认证', 'close-order': '确认关闭订单'
};
// 审计中除表单操作外的动作名称；操作日志按动作筛选时与表单标题一起列出。
const auditActions: Record<string, string> = { 'auth.login': '登录', 'auth.logout': '退出', 'auth.enrolled': '完成账号开通', 'auth.verify': '二次验证', 'orders.export': '导出订单', 'finance.export': '导出财务记录', 'manual-payment-method': '登记核款方式', 'license.expiry-adjusted': '到期调整明细' };
export const actionNames: Record<string, string> = { ...Object.fromEntries(Object.entries(forms).map(([action, form]) => [action, form.title])), ...auditActions };
export const labels: Record<string, string> = {
  offerName: '商品名称', offerRevision: '商品版本', unitAmountFen: '单份金额',
  id: '编号', reference: '业务编号', customer: '客户', customerType: '客户类型', quantity: '份数', amountFen: '金额', useUntil: '到期', updatesUntil: '更新权益截止', state: '状态', channel: '来源', paymentStatus: '付款状态', paymentReference: '付款流水', receivedAt: '确认收款时间', deliveryError: '交付错误', created: '创建时间', openTickets: '待处理工单', refundedFen: '已登记退款', orderId: '原订单', order_id: '订单编号', source: '来源', kind: '授权类型', machineCode: '绑定机器码', status: '状态', bound: '已绑定', revoked: '已撤销', leaseUntil: '最后凭证到期', migrationAfter: '最早可换机时间', lastIssuedAt: '最后签发时间', username: '用户名', role: '角色', enabled: '已启用', enrolled: '已开通', at: '时间', actor: '操作人编号', operator: '操作人', action: '操作', target: '对象', targetLabel: '对象', reason: '原因', result: '结果', request_id: '请求编号', category: '类别', note: '问题描述', conclusion: '授权处理结论', license_id: '授权编号', updated: '更新时间', orderReference: '业务订单号', buyer: '发票抬头', taxId: '税号', pendingOrders: '待付款 / 核款', deliveryPending: '已收款待交付', refundReview: '渠道退款待处理', channelRefundFen: '渠道累计退款', reviewedRefundFen: '已处理退款', expiring: '七日内到期', manualFen: '人工确认收款', onlineFen: '线上确认收款', refundFen: '已退款', service: '服务', backup: '最近备份回执', recovery: '交付恢复任务回执', name: '检查项', checkedAt: '检查时间', detail: '说明'
};
const values: Record<string, string> = { active: '生效中', unbound: '未激活', expiring: '即将到期', revoked: '已撤销', enabled: '正常', disabled: '已停用', 'not-enrolled': '待开通', pending: '待付款', paid: '已收款待交付', fulfilled: '已交付', refunded: '已全额退款', expired: '已过期', confirmed: '已确认', 'not-applicable': '不涉及付款', manual: '线下核款', alipay: '支付宝', wechat: '微信', test: '内测', gift: '赠送', sale: '销售', subscription: '期限授权', perpetual: '永久授权', company: '企业', personal: '个人', open: '待处理', processing: '处理中', closed: '已关闭', requested: '已申请', issued: '已开票', rejected: '无法办理', refund: '退款', invoice: '开票记录', migration: '换机', recovery: '订单找回', other: '其他', success: '成功', denied: '拒绝', ...roleNames };
/** 后台时间一律按北京时间输入和显示，与运营电脑的时区无关。 */
export const beijingTime = (value: string | number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
// 布尔字段逐个写明含义，不用笼统的是 / 否。
const booleanWords: Record<string, readonly [string, string]> = { enabled: ['启用', '已停用'], enrolled: ['已开通', '待开通'] };
// Only enumerated fields are translated; names, usernames and notes are shown exactly as entered.
const enumFields = new Set(['status', 'state', 'paymentStatus', 'channel', 'source', 'kind', 'customerType', 'role', 'result', 'category']);
export function display(key: string, value: string | number | boolean | null): string {
  if (key === 'migrationAfter' && value === null) return '无需等待旧凭证；须先撤销';
  if (key === 'action' && typeof value === 'string') return actionNames[value] ?? value;
  if (value === null) return '—';
  if (typeof value === 'boolean') { const words = booleanWords[key]; if (!words) throw new Error(`字段 ${key} 缺少显示文字`); return value ? words[0] : words[1]; }
  if (key.endsWith('Fen') && typeof value === 'number') return `¥${(value / 100).toFixed(2)}`;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return beijingTime(value);
  return typeof value === 'string' ? enumFields.has(key) ? values[value] ?? value : value : String(value);
}
