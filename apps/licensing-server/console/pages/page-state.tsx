import { CircleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';

/** 读取页面失败：内容区顶部一条红色提示，右边「重试」。 */
export function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return <Alert variant="destructive" className="flex items-center gap-3 px-3 py-2.5">
    <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
    <AlertDescription className="min-w-0 flex-1 break-words">{message}</AlertDescription>
    <Button variant="outline" size="sm" className="max-sm:h-9" onClick={retry}>重试</Button>
  </Alert>;
}

/** 列表还没有数据时：工具行加 6 行占位。 */
export function ListSkeleton() {
  return <div className="flex flex-col gap-4" aria-hidden="true">
    <Skeleton className="h-8 w-full max-w-md" />
    <div className="flex flex-col gap-0 overflow-hidden rounded-lg border">
      <Skeleton className="h-9 rounded-none" />
      {Array.from({ length: 6 }, (_, index) => <div key={index} className="flex items-center gap-4 border-t px-3 py-3.5">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-4 w-1/5" />
        <Skeleton className="h-4 flex-1" />
      </div>)}
    </div>
  </div>;
}

/** 详情还没有数据时：标题加一张卡片的几行。 */
export function DetailSkeleton() {
  return <div className="flex flex-col gap-6" aria-hidden="true">
    <Skeleton className="h-6 w-40" />
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-28 max-w-full" />
        </div>)}
      </CardContent>
    </Card>
  </div>;
}

/** 工作台还没有数据时：几个块的占位。 */
export function OverviewSkeleton() {
  return <div className="grid gap-6 lg:grid-cols-3" aria-hidden="true">
    <Skeleton className="h-72 rounded-xl lg:col-span-2" />
    <Skeleton className="h-72 rounded-xl" />
    <Skeleton className="h-14 rounded-xl lg:col-span-3" />
  </div>;
}
