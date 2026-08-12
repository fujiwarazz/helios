// apps/electron/src/components/Sidebar.tsx —— 侧边栏:品牌 + New chat + 导航 + 会话列表 + 连接状态条。
// electron 专属副本:初始内容参照 apps/web 起步,但独立维护——未来 electron 若要让出原生标题栏
// 空间/加窗口控制按钮,直接改这里,不受 web 端约束(见计划文档"UI 下沉边界"一节)。

import type { ConnectionState } from "@helios/ui-chat";
import type { SessionMetaView } from "../lib/rpc";
import { SessionList } from "./SessionList";

export type NavView = "chat" | "projects" | "artifacts" | "ports" | "customize";

const NAV_ITEMS: { key: NavView; label: string; icon: string }[] = [
  { key: "chat", label: "Chat", icon: "✎" },
  { key: "projects", label: "Projects", icon: "▦" },
  { key: "artifacts", label: "Artifacts", icon: "◈" },
  { key: "ports", label: "Ports", icon: "⚑" },
  { key: "customize", label: "Customize", icon: "⚙" },
];

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  view,
  onNavigate,
  sessions,
  activeSessionId,
  connection,
  now,
  onNewChat,
  onSelectSession,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  view: NavView;
  onNavigate: (v: NavView) => void;
  sessions: SessionMetaView[];
  activeSessionId: string | undefined;
  connection: ConnectionState;
  now: number;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
}): JSX.Element {
  const connLabel =
    connection === "open" ? "已连接" : connection === "connecting" ? "连接中…" : "已断开";

  return (
    <aside className="helios-sidebar" data-collapsed={collapsed ? "true" : "false"}>
      <div className="helios-sidebar-top">
        <div className="helios-brand">
          <span className="helios-brand-mark" aria-hidden>✦</span>
          {!collapsed ? <span className="helios-brand-name">helios</span> : null}
        </div>
        <button
          type="button"
          className="helios-collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <button type="button" data-testid="new-chat" className="helios-new-chat" onClick={onNewChat}>
        <span aria-hidden>＋</span>
        {!collapsed ? <span>New chat</span> : null}
      </button>

      <nav className="helios-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="helios-nav-item"
            data-active={view === item.key ? "true" : "false"}
            onClick={() => onNavigate(item.key)}
            title={item.label}
          >
            <span className="helios-nav-icon" aria-hidden>{item.icon}</span>
            {!collapsed ? <span className="helios-nav-label">{item.label}</span> : null}
          </button>
        ))}
      </nav>

      {!collapsed ? (
        <div className="helios-sidebar-scroll">
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            now={now}
            onSelect={onSelectSession}
          />
        </div>
      ) : null}

      <div className="helios-conn-status" data-state={connection}>
        <span className="helios-conn-dot" aria-hidden />
        {!collapsed ? <span>{connLabel}</span> : null}
      </div>
    </aside>
  );
}
