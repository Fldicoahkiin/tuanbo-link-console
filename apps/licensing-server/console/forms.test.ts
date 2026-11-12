import { describe, expect, it } from 'vitest';
import { actionSchema } from '../src/console-contract';
import { display, extendBeijing, forms, fromBeijingInput, initialValues, toActionInput, toBeijingInput, validateFields } from './forms';

it('枚举字段显示中文，客户名、用户名和备注保持原样', () => {
  expect(display('state', 'fulfilled')).toBe('已交付');
  expect(display('customerType', 'company')).toBe('企业');
  expect(display('role', 'owner')).toBe('管理员');
  expect(display('customer', 'test')).toBe('test');
  expect(display('username', 'owner')).toBe('owner');
  expect(display('actor', 'operations')).toBe('operations');
  expect(display('buyer', 'personal')).toBe('personal');
});

describe('北京时间的输入框', () => {
  it('时间戳和输入框的值互为逆运算，按北京时间算', () => {
    const ms = Date.parse('2026-11-12T16:30:00Z');
    expect(toBeijingInput(ms)).toBe('2026-11-13T00:30');
    expect(fromBeijingInput('2026-11-13T00:30')).toBe('2026-11-12T16:30:00.000Z');
    expect(Date.parse(fromBeijingInput(toBeijingInput(ms)))).toBe(ms);
    expect(fromBeijingInput('')).toBe('');
    expect(fromBeijingInput('2026-02-30T10:00')).toBe('');
  });

  it('快捷按钮：有值就在它上面加，时分不变', () => {
    expect(extendBeijing('2026-11-06T16:00', 7, 0)).toBe('2026-11-13T16:00');
    expect(extendBeijing('2026-12-31T08:15', 365, 0)).toBe('2027-12-31T08:15');
  });

  it('快捷按钮：空的就从服务器的今天（北京时间）算起，定在 23:59', () => {
    // 服务器时间是 UTC 10 月 6 日 20:00，北京已经是 10 月 7 日。
    expect(extendBeijing('', 30, Date.parse('2026-10-06T20:00:00Z'))).toBe('2026-11-06T23:59');
  });
});

describe('validateFields', () => {
  const values = (extra: Record<string, string>) => ({ ...initialValues('create-order', forms['create-order'].fields, null), reference: 'A-1', customer: '客户', useUntil: '2026-11-06T16:00', amountFen: '800', ...extra });
  const check = (extra: Record<string, string>) => validateFields(forms['create-order'].fields, values(extra));

  it('都填对时没有错误', () => {
    expect(check({})).toEqual({});
  });

  it('必填的文本、日期为空：请填写（去掉括号里的说明）', () => {
    expect(check({ customer: ' ' })).toEqual({ customer: '请填写客户名称' });
    expect(check({ useUntil: '' })).toEqual({ useUntil: '请填写授权截止时间' });
  });

  it('必填的下拉为空：请选择', () => {
    expect(validateFields(forms['update-user'].fields, { role: '', enabled: 'true', reason: '' })).toEqual({ role: '请选择角色' });
  });

  it('另一个字段等于某个值时必填', () => {
    const fields = forms['update-feedback'].fields;
    expect(validateFields(fields, { state: 'closed', conclusion: '', reason: '' })).toEqual({ conclusion: '关闭前请写明处理结论' });
    expect(validateFields(fields, { state: 'processing', conclusion: '', reason: '' })).toEqual({});
    expect(validateFields(forms.invoice.fields, { state: 'issued', buyer: '客户', taxId: '', reference: '', reason: '' })).toEqual({ reference: '已开票必须填写发票编号' });
  });

  it('金额至少 0.01 元、最多两位小数', () => {
    expect(check({ amountFen: '0' })).toEqual({ amountFen: '金额至少 0.01 元，最多两位小数' });
    expect(check({ amountFen: '1.234' })).toEqual({ amountFen: '金额至少 0.01 元，最多两位小数' });
    expect(check({ amountFen: '0.01' })).toEqual({});
  });

  it('授权数量是 1 到 100 的整数', () => {
    expect(check({ quantity: '101' })).toEqual({ quantity: '请填 1 到 100 的整数' });
    expect(check({ quantity: '1.5' })).toEqual({ quantity: '请填 1 到 100 的整数' });
  });

  it('时间要能解析', () => {
    expect(check({ useUntil: '2026-13-01T00:00' })).toEqual({ useUntil: '请选择时间' });
  });

  it('超过长度：文本 160、原因 500', () => {
    expect(check({ customer: '字'.repeat(161) })).toEqual({ customer: '最多 160 个字' });
    expect(validateFields(forms.revoke.fields, { reason: '字'.repeat(501) })).toEqual({ reason: '最多 500 个字' });
    expect(validateFields(forms['alipay-refund'].fields, { amountFen: '1', reason: '字'.repeat(257) })).toEqual({ reason: '最多 256 个字' });
  });
});

describe('toActionInput', () => {
  const id = '6f1d3a8e-5d0b-4f55-9a43-2b7c1f0e9d11';

  it('确认收款：金额元转分，常用项的文字就是付款方式', () => {
    const input = toActionInput('fulfill', { id }, forms.fulfill.fields, { amountFen: '800.1', paymentReference: 'BANK-1', paymentMethod: '对公转账', reason: '' });
    expect(input).toEqual({ action: 'fulfill', id, amountFen: 80010, paymentReference: 'BANK-1', paymentMethod: '对公转账', reason: '' });
    expect(actionSchema.safeParse(input).success).toBe(true);
  });

  it('调整到期时间：北京时间换成 ISO，默认值是原到期时间', () => {
    const row = { id, useUntil: '2026-11-06T08:00:00.000Z' };
    expect(initialValues('set-expiry', forms['set-expiry'].fields, row).useUntil).toBe('2026-11-06T16:00');
    const input = toActionInput('set-expiry', row, forms['set-expiry'].fields, { useUntil: '2026-12-06T16:00', reason: '延长试用' });
    expect(input).toEqual({ action: 'set-expiry', id, useUntil: '2026-12-06T08:00:00.000Z', reason: '延长试用' });
    expect(actionSchema.safeParse(input).success).toBe(true);
  });

  it('修改人员权限：账号状态换成布尔', () => {
    const row = { id, role: 'operations', enabled: true };
    const values = initialValues('update-user', forms['update-user'].fields, row);
    expect(values).toEqual({ role: 'operations', enabled: 'true', reason: '' });
    const input = toActionInput('update-user', row, forms['update-user'].fields, { ...values, enabled: 'false' });
    expect(input).toEqual({ action: 'update-user', id, role: 'operations', enabled: false, reason: '' });
    expect(actionSchema.safeParse(input).success).toBe(true);
  });

  it('下拉只认列出来的选项，不在里面就取第一项', () => {
    expect(initialValues('invoice', forms.invoice.fields, { id, state: 'fulfilled' }).state).toBe('requested');
    expect(initialValues('update-ticket', forms['update-ticket'].fields, { id, state: 'closed' }).state).toBe('closed');
  });

  it('常用项只认列出来的文字', () => {
    expect(initialValues('create-user', forms['create-user'].fields, { role: 'owner', reason: '备用管理员' })).toEqual({ username: '', role: 'owner', reason: '备用管理员' });
    expect(initialValues('revoke', forms.revoke.fields, { id, reason: '别的说明' })).toEqual({ reason: '' });
  });
});
