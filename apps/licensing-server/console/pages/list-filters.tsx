import { useRef } from 'react';
import { Search } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { display } from '../forms';
import type { Filter } from '../location';
import { channelOptions, searchPlaceholder, stateFilters } from '../navigation';

type FiltersProps = {
  route: string;
  filter: Filter;
  busy: boolean;
  applyForm: (form: HTMLFormElement, override?: Partial<Filter>) => void;
};

const label = 'text-muted-foreground text-xs font-normal';
const control = 'max-sm:h-9';

function FilterSelect({ id, name, title, options, value, onChange }: {
  id: string; name: 'state' | 'channel'; title: string; options: [string, string][]; value: string; onChange: (value: string) => void;
}) {
  const items = [{ value: '', label: '全部' }, ...options.map(([key, text]) => ({ value: key, label: text }))];
  return <div className="flex flex-col gap-1.5">
    <Label htmlFor={id} className={label}>{title}</Label>
    <Select name={name} items={items} defaultValue={value} onValueChange={next => onChange(typeof next === 'string' ? next : '')}>
      <SelectTrigger id={id} className={`w-32 ${control}`}><SelectValue /></SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map(item => <SelectItem key={item.value || 'all'} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

/** 列表的筛选：搜索、状态和来源（选了立刻生效）、日期，点「查询」生效。筛选写进网址由 ConsoleApp 负责。 */
export function ListFilters({ route, filter, busy, applyForm }: FiltersProps) {
  const form = useRef<HTMLFormElement>(null);
  const choose = (name: 'state' | 'channel') => (value: string) => { if (form.current) applyForm(form.current, { [name]: value }); };
  const states = stateFilters[route];
  const dated = ['orders', 'exceptions', 'finance'].includes(route);
  return <form ref={form} key={route} className="flex min-w-0 flex-wrap items-end gap-3"
    onSubmit={event => { event.preventDefault(); applyForm(event.currentTarget); }}>
    <div className="flex w-full flex-col gap-1.5 sm:w-64">
      <Label htmlFor={`${route}-q`} className="sr-only">搜索</Label>
      <InputGroup className={control}>
        <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
        <InputGroupInput id={`${route}-q`} name="q" aria-label="搜索" defaultValue={filter.q} placeholder={searchPlaceholder(route)} />
      </InputGroup>
    </div>
    {states && <FilterSelect id={`${route}-state`} name="state" title={states.label} options={states.options} value={filter.state} onChange={choose('state')} />}
    {['orders', 'exceptions'].includes(route) && <FilterSelect id={`${route}-channel`} name="channel" title="来源"
      options={channelOptions.map(value => [value, display('channel', value)])} value={filter.channel} onChange={choose('channel')} />}
    {dated && <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${route}-from`} className={label}>{route === 'finance' ? '起日' : '创建起日'}</Label>
        <Input id={`${route}-from`} type="date" name="from" defaultValue={filter.from} className={`w-36 ${control}`} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${route}-to`} className={label}>{route === 'finance' ? '止日' : '创建止日'}</Label>
        <Input id={`${route}-to`} type="date" name="to" defaultValue={filter.to} className={`w-36 ${control}`} />
      </div>
    </>}
    <Button type="submit" variant="outline" className={control} disabled={busy}>查询</Button>
  </form>;
}
