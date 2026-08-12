// apps/electron/src/lib/time.ts —— 相对时间 + 会话按时间分组。纯函数,便于测试。
// 与 apps/web/src/lib/time.ts 内容一致——纯工具函数无宿主耦合,复制成本低于抽一个共享包的成本
// (参见 VectorX.md/计划文档"UI 下沉边界"一节:不为了共享而共享)。

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期。 */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export type TimeGroup = "今天" | "昨天" | "过去 7 天" | "更早";

/** 按 updatedAt 归入时间分组(基于本地自然日边界)。 */
export function timeGroup(ts: number, now: number): TimeGroup {
  const startOfDay = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today0 = startOfDay(now);
  const day = 24 * 60 * 60 * 1000;
  if (ts >= today0) return "今天";
  if (ts >= today0 - day) return "昨天";
  if (ts >= today0 - 7 * day) return "过去 7 天";
  return "更早";
}

export const GROUP_ORDER: TimeGroup[] = ["今天", "昨天", "过去 7 天", "更早"];
