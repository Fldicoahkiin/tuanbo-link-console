import { PackageOpen } from 'lucide-react';
import type { ConsoleRow } from '../../src/console-contract';
import { PageCard } from '../components/page-card';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../components/ui/empty';
import { forms } from '../forms';
import { Fields } from '../table';
import type { ActionName, Detail } from '../console-app';

type UpdatesProps = {
  detail: Detail;
  can: (action: ActionName) => boolean;
  open: (action: ActionName, row: ConsoleRow) => void;
};

/** 软件更新：当前更新源和可回滚的版本、待发布的候选版本。 */
export function UpdatesPage({ detail, can, open }: UpdatesProps) {
  const item = detail.item;
  // 条件与改版前相同：有可回滚的版本、且没有不能回滚的原因。
  const rollback = item.rollbackVersion && !item.rollbackIssue && can('rollback-update') ? item.rollbackVersion : null;
  // 第一个能发布的候选用主按钮，其余用普通按钮。
  const firstPublishable = detail.related.find(row => !row.issue);
  return <div className="flex flex-col gap-6">
    <PageCard title="更新源" contentClassName="flex flex-col gap-4">
      <Fields row={item} />
      {rollback && <div className="flex flex-wrap gap-2">
        <Button variant="destructive" className="max-sm:h-10" onClick={() => open('rollback-update', { id: rollback })}>{forms['rollback-update'].title}</Button>
      </div>}
    </PageCard>
    <PageCard title="待发布版本" contentClassName="flex flex-col gap-3">
      {detail.related.length ? detail.related.map(row => <div key={String(row.id)} className="flex flex-col gap-4 rounded-lg border p-4">
        <Fields row={row} />
        {(!row.issue && can('publish-update') || can('discard-update')) && <div className="flex flex-wrap gap-2">
          {!row.issue && can('publish-update') && <Button variant={row === firstPublishable ? 'default' : 'outline'} className="max-sm:h-10" onClick={() => open('publish-update', row)}>
            {forms['publish-update'].title}
          </Button>}
          {can('discard-update') && <Button variant="destructive" className="max-sm:h-10" onClick={() => open('discard-update', row)}>{forms['discard-update'].title}</Button>}
        </div>}
      </div>) : <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><PackageOpen aria-hidden="true" /></EmptyMedia>
          <EmptyDescription>没有待发布的版本。构建机上传、还没上线的正式包会出现在这里。</EmptyDescription>
        </EmptyHeader>
      </Empty>}
    </PageCard>
  </div>;
}
