// apps/web/src/pages/PortsPage.tsx —— Ports 页:只读展示宿主已装配的 port/工具(真实 ports.list 数据)。

import type { PortInfoView } from "../lib/rpc";

export function PortsPage({ ports }: { ports: PortInfoView[] }): JSX.Element {
  return (
    <div className="helios-page">
      <div className="helios-page-title">Ports</div>
      <div className="helios-page-hint">已装配的能力提供者与工具(只读)。</div>
      {ports.length === 0 ? (
        <div className="helios-page-hint">尚无数据(未连接或无工具)。</div>
      ) : (
        <div className="helios-ports">
          {ports.map((p) => (
            <div key={p.provider} className="helios-port-card">
              <div className="helios-port-head">
                <span className="helios-port-name">{p.provider}</span>
                <span className="helios-port-count">{p.tools.length} 个工具</span>
              </div>
              <div className="helios-port-tools">
                {p.tools.map((t) => (
                  <span key={t} className="helios-port-tool">{t}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
