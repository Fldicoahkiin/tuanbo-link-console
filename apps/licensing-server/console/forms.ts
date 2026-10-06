import type { ConsoleAction } from '../src/console-contract';
export type Field = { key: string; label: string; type?: 'number' | 'datetime-local' | 'textarea' | 'select'; options?: readonly [string, string][]; optional?: boolean };
const reason: Field = { key: 'reason', label: '操作原因', type: 'textarea' };
const customer: Field[] = [{ key: 'customer', label: '客户名称' }, { key: 'customerType', label: '客户类型', type: 'select', options: [['company', '企业'], ['personal', '个人']] }, { key: 'quantity', label: '授权数量（1–100）', type: 'number' }, { key: 'useUntil', label: '授权截止时间（本地时间）', type: 'datetime-local' }];
const amount: Field = { key: 'amountFen', label: '金额（元）', type: 'number' };
const roles: [string, string][] = [['owner', '负责人'], ['operations', '运营'], ['finance', '财务'], ['viewer', '只读']];
export const roleNames = Object.fromEntries(roles);
export const forms: Record<ConsoleAction['action'], { title: string; note: string; fields: Field[] }> = {
  'create-order': { title: '创建线下订单', note: '仅登记尚待核款的线下成交；有效期按填写的截止时间确定。', fields: [{ key: 'reference', label: '业务订单编号' }, ...customer, amount, reason] },
  fulfill: { title: '确认实际收款并发码', note: '请先核实真实到账；系统将按此记录签发授权。不能将线上订单改为人工核款。', fields: [amount, { key: 'paymentReference', label: '真实收款流水号' }, { key: 'paymentMethod', label: '付款方式' }, reason] },
  reconcile: { title: '向支付渠道查单', note: '按订单原渠道核验付款，不会再次扣款。', fields: [reason] },
  'retry-delivery': { title: '补交付', note: '仅使用已保存的可信收款事实，不让客户重新付款。', fields: [reason] },
  'delivery-access': { title: '重发领取凭据', note: '原领取凭据立即失效。新凭据仅交给已核实的购买人。', fields: [reason] },
  'revoke-delivery-access': { title: '撤销领取凭据', note: '只撤销订单领取权限，不撤销软件授权。', fields: [reason] },
  reveal: { title: '查看完整激活码', note: '此次查看将记录操作人和原因。', fields: [reason] },
  revoke: { title: '撤销授权', note: '将阻止新的激活和启动验证。已运行会话不会立即停止，此操作不会退款。', fields: [reason] },
  migrate: { title: '办理换机', note: '必须先撤销，等待最后凭证到期及五分钟容差。成功后旧码失效，新码尚未绑定。', fields: [reason] },
  grant: { title: '签发特殊授权', note: '仅负责人可签发；一码一机，有明确截止时间，不计入收款台账。', fields: [...customer, { key: 'purpose', label: '授权用途', type: 'select', options: [['test', '内测'], ['gift', '赠送']] }, reason] },
  'create-user': { title: '添加人员', note: '生成一次性开通凭据，24 小时内完成密码和验证器设置。', fields: [{ key: 'username', label: '用户名（英文、数字、点、横线）' }, { key: 'role', label: '角色', type: 'select', options: roles }, reason] },
  'update-user': { title: '修改人员权限', note: '保存后该人员的已有会话立即失效。不能禁用或降级最后一个已开通负责人。', fields: [{ key: 'role', label: '角色', type: 'select', options: roles }, { key: 'enabled', label: '账号状态', type: 'select', options: [['true', '启用'], ['false', '禁用']] }, reason] },
  'reset-user': { title: '重置人员认证', note: '原密码、验证器和会话失效，需要重新开通。', fields: [reason] },
  'create-ticket': { title: '创建售后工单', note: '关联当前订单；如涉及特定授权，请填写该订单下的授权 ID。', fields: [{ key: 'licenseId', label: '授权 ID（可选）', optional: true }, { key: 'category', label: '问题类别', type: 'select', options: [['migration', '换机'], ['refund', '退款'], ['invoice', '开票'], ['recovery', '订单找回'], ['other', '其他']] }, { key: 'note', label: '问题描述', type: 'textarea' }, reason] },
  'update-ticket': { title: '处理工单', note: '关闭工单必须写明授权处理结论；退款与撤销分别办理。', fields: [{ key: 'state', label: '处理状态', type: 'select', options: [['processing', '处理中'], ['closed', '关闭'], ['open', '待处理']] }, { key: 'conclusion', label: '授权处理结论', type: 'textarea', optional: true }, reason] },
  refund: { title: '登记已办理的退款', note: '只记录人工办理结果，不会调用支付渠道退款，也不会自动撤销授权。', fields: [amount, { key: 'reference', label: '退款渠道凭证编号' }, { key: 'handledAt', label: '实际办理时间', type: 'datetime-local' }, reason] },
  invoice: { title: '记录开票进度', note: '系统未接入自动开票；此处记录人工办理进度，不生成税务发票。', fields: [{ key: 'state', label: '办理状态', type: 'select', options: [['requested', '已申请'], ['processing', '办理中'], ['issued', '已开票'], ['rejected', '无法办理']] }, { key: 'buyer', label: '购买方抬头' }, { key: 'taxId', label: '税号（可选）', optional: true }, { key: 'reference', label: '发票编号（已开票必填）', optional: true }, reason] }
};
export const labels: Record<string, string> = {
  offerName: '商品名称', offerRevision: '商品版本', unitAmountFen: '单份金额',
  id: '编号', reference: '业务编号', customer: '客户', customerType: '客户类型', quantity: '份数', amountFen: '金额', useUntil: '使用截止', updatesUntil: '更新权益截止', state: '状态', channel: '来源 / 渠道', paymentStatus: '付款状态', paymentReference: '付款流水', receivedAt: '确认收款时间', deliveryError: '交付错误', created: '创建时间', openTickets: '待处理工单', refundedFen: '已登记退款', orderId: '原订单', order_id: '订单编号', source: '来源', kind: '授权类型', machineCode: '绑定机器码', bound: '已绑定', revoked: '已撤销', leaseUntil: '最后凭证到期', migrationAfter: '最早可换机时间', lastIssuedAt: '最后签发时间', username: '用户名', role: '角色', enabled: '已启用', enrolled: '已开通', at: '时间', actor: '操作人编号', operator: '操作人', action: '操作', target: '对象', reason: '原因', result: '结果', request_id: '请求编号', category: '类别', note: '问题描述', conclusion: '授权处理结论', license_id: '授权编号', updated: '更新时间', orderReference: '业务订单号', buyer: '发票抬头', taxId: '税号', pendingOrders: '待付款 / 核款', deliveryPending: '已收款待交付', expiring: '七日内到期', manualFen: '人工确认收款', onlineFen: '线上确认收款', refundFen: '人工登记退款', service: '服务', backup: '最近备份回执', recovery: '交付恢复任务回执', name: '检查项', checkedAt: '检查时间', detail: '说明'
};
const values: Record<string, string> = { pending: '待处理', fulfilled: '已交付', confirmed: '已确认', 'not-applicable': '不涉及付款', manual: '线下核款', alipay: '支付宝', wechat: '微信', test: '内测', gift: '赠送', sale: '销售', subscription: '期限授权', perpetual: '永久授权', company: '企业', personal: '个人', open: '待处理', processing: '处理中', closed: '已关闭', requested: '已申请', issued: '已开票', rejected: '无法办理', refund: '人工退款登记', invoice: '开票记录', migration: '换机', recovery: '订单找回', other: '其他', success: '成功', denied: '拒绝', ...roleNames };
export function display(key: string, value: string | number | boolean | null): string {
  if (key === 'migrationAfter' && value === null) return '无需等待旧凭证；须先撤销';
  if (key === 'action' && typeof value === 'string') return Object.entries(forms).find(([action]) => action === value)?.[1].title ?? ({ 'auth.login': '登录', 'auth.logout': '退出', 'auth.enrolled': '完成账号开通', 'auth.verify': '二次验证', 'orders.export': '导出台账', 'manual-payment-method': '登记核款方式' } as Record<string, string>)[value] ?? value;
  if (value === null) return '未采集 / 不适用';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key.endsWith('Fen') && typeof value === 'number') return `¥${(value / 100).toFixed(2)}`;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toLocaleString('zh-CN');
  return typeof value === 'string' ? values[value] ?? value : String(value);
}
