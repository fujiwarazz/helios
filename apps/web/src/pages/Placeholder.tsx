// apps/web/src/pages/Placeholder.tsx —— 占位页(Projects/Artifacts/Customize),本期为惰性展示。

export function Placeholder({ title, hint }: { title: string; hint: string }): JSX.Element {
  return (
    <div className="helios-page">
      <div className="helios-page-title">{title}</div>
      <div className="helios-page-hint">{hint}</div>
    </div>
  );
}
