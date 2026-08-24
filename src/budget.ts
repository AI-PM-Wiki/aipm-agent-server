/**
 * 每日预算护栏:按 UTC 日累计已消耗成本(基于 SDK total_cost_usd)。
 *
 * 原子预占模型(消除「检查→执行→记账」的竞态窗口):请求先 tryReserve
 * 预占单轮理论最大成本,执行后按实际成本 settle 结算,异常路径 release 释放。
 * Node 单线程下 tryReserve 的「检查+预占」是同步步骤,在事件循环内原子完成,
 * 并发请求不可能同时通过;即便并发 N 个请求,预占总量也不会超过预算。
 * 进程内状态,单实例假设:重启清零(README 已注明;多实例需换共享存储,记 deferred)。
 * budgetUsd = 0 表示关闭护栏(remaining 恒为正、永不 exhausted)。
 * 时区说明:按 UTC 日切,东八区用户的"一天"从北京时间 08:00 开始。
 */
export class DailyBudget {
  private readonly budgetUsd: number;
  private readonly now: () => Date;
  private day: string;
  private spent = 0;
  /** 已预占未结算量(进行中请求的理论最大成本之和)。 */
  private reserved = 0;

  constructor(budgetUsd: number, now: () => Date = () => new Date()) {
    this.budgetUsd = budgetUsd;
    this.now = now;
    this.day = this.dayKey();
  }

  private dayKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** 跨日自动重置(已消耗与预占一并清零)。 */
  private resetIfNewDay(): void {
    const key = this.dayKey();
    if (key !== this.day) {
      this.day = key;
      this.spent = 0;
      this.reserved = 0;
    }
  }

  /** 当日已消耗(USD)。 */
  get spentUsd(): number {
    return this.spent;
  }

  /** 当日预占未结算(USD,进行中请求的预留量)。 */
  get reservedUsd(): number {
    return this.reserved;
  }

  /** 剩余可预分配预算(USD);护栏关闭时为 Infinity。 */
  get remainingUsd(): number {
    if (this.budgetUsd <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.budgetUsd - this.spent - this.reserved);
  }

  /** 是否已超预算(含预占;供日志/统计使用,请求准入请用 tryReserve)。 */
  get exhausted(): boolean {
    if (this.budgetUsd <= 0) return false;
    this.resetIfNewDay();
    return this.spent + this.reserved >= this.budgetUsd;
  }

  /**
   * 原子预占:同步完成「检查+记账」。Node 单线程下该同步步骤在事件循环内
   * 原子执行,无「先检查后记账」的竞态窗口;超支上限 = 并发数 × 单轮理论
   * 最大成本(由 SDK 侧 MAX_BUDGET_USD 兜底)。
   * 预算关闭(<=0)时恒 true;余量不足时返回 false,调用方应拒绝请求。
   */
  tryReserve(estimateUsd: number): boolean {
    if (this.budgetUsd <= 0) return true;
    this.resetIfNewDay();
    if (this.spent + this.reserved + estimateUsd > this.budgetUsd) return false;
    this.reserved += estimateUsd;
    return true;
  }

  /**
   * 结算:预占转实际消耗(costUsd 可为 0/undefined 语义,未产生费用也需
   * settle 以释放预占)。跨日时已重置的预占按 0 截断,避免负预占放大余量;
   * 跨日成本计入新的一天(与旧 track 行为一致,边界场景可接受)。
   */
  settle(estimateUsd: number, costUsd: number): void {
    this.resetIfNewDay();
    this.reserved = Math.max(0, this.reserved - estimateUsd);
    this.spent += costUsd;
  }

  /** 异常路径释放预占(请求未执行即失败/抛异常时调用)。 */
  release(estimateUsd: number): void {
    this.resetIfNewDay();
    this.reserved = Math.max(0, this.reserved - estimateUsd);
  }

  /** 直接记账一次消耗(不涉及预占;保留给测试/统计场景,服务主路径用 settle)。 */
  track(costUsd: number): void {
    this.resetIfNewDay();
    this.spent += costUsd;
  }
}
