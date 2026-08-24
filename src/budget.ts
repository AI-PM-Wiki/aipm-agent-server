/**
 * 每日预算护栏:按 UTC 日累计已消耗成本(基于 SDK total_cost_usd)。
 *
 * 进程内状态,单实例假设:重启清零(README 已注明;多实例需换共享存储)。
 * budgetUsd = 0 表示关闭护栏(remaining 恒为正、永不 exhausted)。
 * 时区说明:按 UTC 日切,东八区用户的"一天"从北京时间 08:00 开始。
 */
export class DailyBudget {
  private readonly budgetUsd: number;
  private readonly now: () => Date;
  private day: string;
  private spent = 0;

  constructor(budgetUsd: number, now: () => Date = () => new Date()) {
    this.budgetUsd = budgetUsd;
    this.now = now;
    this.day = this.dayKey();
  }

  private dayKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** 当日已消耗(USD)。 */
  get spentUsd(): number {
    return this.spent;
  }

  /** 剩余预算(USD);护栏关闭时为 Infinity。 */
  get remainingUsd(): number {
    if (this.budgetUsd <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.budgetUsd - this.spent);
  }

  /** 是否已超预算(后续请求应拒绝)。 */
  get exhausted(): boolean {
    if (this.budgetUsd <= 0) return false;
    if (this.dayKey() !== this.day) {
      this.day = this.dayKey();
      this.spent = 0;
    }
    return this.spent >= this.budgetUsd;
  }

  /** 记录一次请求的实际消耗;跨日自动重置。 */
  track(costUsd: number): void {
    if (this.dayKey() !== this.day) {
      this.day = this.dayKey();
      this.spent = 0;
    }
    this.spent += costUsd;
  }
}
