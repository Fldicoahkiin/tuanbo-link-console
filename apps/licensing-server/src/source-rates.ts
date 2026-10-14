/** 进程内来源计数：每个来源一分钟窗口；表满时淘汰最久未用的来源，不拒绝新地址。 */
export class SourceRates {
  private readonly rates = new Map<string, { count: number; reset: number }>();
  constructor(private readonly capacity: number) {}
  /** 计入一次请求，返回窗口内是否已超过上限。 */
  exceeded(source: string, limit: number, now: number): boolean {
    for (const [key, value] of this.rates) if (value.reset <= now) this.rates.delete(key);
    const rate = this.rates.get(source) ?? { count: 0, reset: now + 60000 };
    // Map 按插入序迭代：命中即移到末尾，表满时淘汰最久未用的来源。
    this.rates.delete(source);
    if (this.rates.size >= this.capacity) {
      const oldest = this.rates.keys().next();
      if (!oldest.done) this.rates.delete(oldest.value);
    }
    this.rates.set(source, rate);
    return ++rate.count > limit;
  }
}
