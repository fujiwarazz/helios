// apps/electron/src/components/SessionList.tsx —— 侧边栏会话列表:按时间分组 + 相对时间 + 当前高亮。
// electron 专属副本(与 apps/web 同款,但独立维护,不建立共享依赖——见计划文档"UI 下沉边界")。

import type { SessionMetaView } from "../lib/rpc";
import { relativeTime, timeGroup, GROUP_ORDER, type TimeGroup } from "../lib/time";

export function SessionList({
  sessions,
  activeSessionId,
  now,
  onSelect,
}: {
  sessions: SessionMetaView[];
  activeSessionId: string | undefined;
  now: number;
  onSelect: (id: string) => void;
}): JSX.Element {
  if (sessions.length === 0) {
    return <div className="helios-sessions-empty">还没有会话</div>;
  }

  const groups = new Map<TimeGroup, SessionMetaView[]>();
  for (const s of sessions) {
    const g = timeGroup(s.updatedAt, now);
    const list = groups.get(g) ?? [];
    list.push(s);
    groups.set(g, list);
  }

  return (
    <div data-testid="session-list" className="helios-sessions">
      {GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
        <div key={g} className="helios-session-group">
          <div className="helios-session-group-label">{g}</div>
          {groups.get(g)!.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid="session-item"
              data-active={s.id === activeSessionId ? "true" : "false"}
              className="helios-session-item"
              onClick={() => onSelect(s.id)}
              title={s.title || s.id}
            >
              <span className="helios-session-title">{s.title || "未命名会话"}</span>
              <span className="helios-session-time">{relativeTime(s.updatedAt, now)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
