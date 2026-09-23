import type { SqliteCronStore } from "../store/sqlite-cron-store";

/**
 * Usage aggregator for cron job analytics.
 * Provides aggregated statistics and insights about automated job performance.
 */
export class CronUsageAggregator {
  private readonly store: SqliteCronStore;

  constructor(store: SqliteCronStore) {
    this.store = store;
  }

  /**
   * Get aggregated usage statistics for all schedules.
   */
  async getGlobalUsageStats(): Promise<{
    totalExecutions: number;
    successRate: number;
    avgDurationMs: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    mostActiveScheduleId: string | null;
    errorRateBySchedule: Record<string, number>;
  }> {
    const allRuns = this.store.listRuns({ limit: 10000 });
    const schedules = this.store.listSpecs();

    if (allRuns.length === 0) {
      return {
        totalExecutions: 0,
        successRate: 0,
        avgDurationMs: 0,
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        mostActiveScheduleId: null,
        errorRateBySchedule: {},
      };
    }

    const totalExecutions = allRuns.length;
    const successfulExecutions = allRuns.filter(
      (r) => r.status === "done"
    ).length;
    const successRate = successfulExecutions / totalExecutions;

    const avgDurationMs =
      allRuns.reduce((sum, r) => {
        if (r.startedAt && r.completedAt) {
          return (
            sum +
            new Date(r.completedAt).getTime() -
            new Date(r.startedAt).getTime()
          );
        }
        return sum;
      }, 0) / totalExecutions;

    // Calculate most active schedule
    const scheduleCount: Record<string, number> = {};
    allRuns.forEach((r) => {
      scheduleCount[r.specId] = (scheduleCount[r.specId] ?? 0) + 1;
    });
    let mostActiveScheduleId: string | null = null;
    let maxCount = 0;
    Object.entries(scheduleCount).forEach(([id, count]) => {
      if (count > maxCount) {
        maxCount = count;
        mostActiveScheduleId = id;
      }
    });

    // Calculate error rate by schedule
    const errorRateBySchedule: Record<string, number> = {};
    schedules.forEach((s) => {
      const specRuns = allRuns.filter((r) => r.specId === s.specId);
      if (specRuns.length > 0) {
        const failed = specRuns.filter(
          (r) => r.status === "failed"
        ).length;
        errorRateBySchedule[s.specId] = failed / specRuns.length;
      }
    });

    return {
      totalExecutions,
      successRate,
      avgDurationMs,
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      mostActiveScheduleId,
      errorRateBySchedule,
    };
  }

  /**
   * Get usage statistics for a specific schedule.
   */
  async getScheduleUsageStats(
    scheduleId: string
  ): Promise<{
    totalRuns: number;
    successRate: number;
    avgDurationMs: number;
    lastFailure: { runId: string; error: string; endedAt: string } | undefined;
  }> {
    const runs = this.store.listRuns({ specId: scheduleId, limit: 10000 });

    if (runs.length === 0) {
      return {
        totalRuns: 0,
        successRate: 0,
        avgDurationMs: 0,
        lastFailure: undefined,
      };
    }

    const totalRuns = runs.length;
    const successful = runs.filter((r) => r.status === "done").length;
    const successRate = successful / totalRuns;

    const avgDurationMs =
      runs.reduce((sum, r) => {
        if (r.startedAt && r.completedAt) {
          return (
            sum +
            new Date(r.completedAt).getTime() -
            new Date(r.startedAt).getTime()
          );
        }
        return sum;
      }, 0) / totalRuns;

    const failedRuns = runs.filter((r) => r.status === "failed");
    const lastFailure =
      failedRuns.length > 0
        ? failedRuns.sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() -
              new Date(a.updatedAt).getTime()
          )[0]
        : undefined;

    return {
      totalRuns,
      successRate,
      avgDurationMs,
      lastFailure: lastFailure
        ? {
            runId: lastFailure.runId,
            error: lastFailure.error ?? "unknown",
            endedAt: lastFailure.updatedAt,
          }
        : undefined,
    };
  }

  /**
   * Get recent execution history for dashboard display.
   */
  async getRecentExecutions(
    limit: number = 10
  ): Promise<
    Array<{
      runId: string;
      specId: string;
      status: string;
      startedAt: string | undefined;
      completedAt: string | undefined;
      durationMs: number | null;
      error: string | undefined;
      attemptCount: number;
      triggerKind: string;
    }>
  > {
    const runs = this.store.listRuns({ limit });
    return runs.map((r) => ({
      runId: r.runId,
      specId: r.specId,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      durationMs:
        r.startedAt && r.completedAt
          ? new Date(r.completedAt).getTime() -
            new Date(r.startedAt).getTime()
          : null,
      error: r.error,
      attemptCount: r.attemptCount,
      triggerKind: r.triggerKind,
    }));
  }

  /**
   * Get daily performance trends (aggregates runs by date).
   */
  async getDailyPerformanceTrends(
    days: number = 7
  ): Promise<
    Array<{
      date: string;
      executions: number;
      successRate: number;
      avgDurationMs: number;
    }>
  > {
    const allRuns = this.store.listRuns({ limit: 10000 });
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const recentRuns = allRuns.filter((r) => {
      if (!r.startedAt) return false;
      return new Date(r.startedAt).getTime() >= cutoff;
    });

    // Group by date
    const dailyData: Record<
      string,
      {
        count: number;
        successCount: number;
        totalDurationMs: number;
      }
    > = {};

    recentRuns.forEach((r) => {
      const date = r.startedAt
        ? new Date(r.startedAt).toISOString().split("T")[0]
        : "unknown";
      if (!dailyData[date]) {
        dailyData[date] = {
          count: 0,
          successCount: 0,
          totalDurationMs: 0,
        };
      }
      dailyData[date].count += 1;
      if (r.status === "done") dailyData[date].successCount += 1;
      if (r.startedAt && r.completedAt) {
        dailyData[date].totalDurationMs +=
          new Date(r.completedAt).getTime() -
          new Date(r.startedAt).getTime();
      }
    });

    return Object.entries(dailyData)
      .map(([date, data]) => ({
        date,
        executions: data.count,
        successRate: data.successCount / data.count,
        avgDurationMs: data.totalDurationMs / data.count,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}