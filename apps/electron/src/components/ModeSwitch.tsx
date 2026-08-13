import type { SessionMode } from "@helios/workspace/types";

export interface ModeSwitchProps {
  mode: SessionMode;
  disabled?: boolean;
  onChange(mode: SessionMode): void;
}

export function ModeSwitch({ mode, disabled = false, onChange }: ModeSwitchProps): JSX.Element {
  return (
    <div className="helios-mode-switch" role="group" aria-label="会话模式">
      {(["chat", "code"] as const).map((value) => (
        <button
          key={value}
          type="button"
          data-testid={"mode-" + value}
          aria-pressed={mode === value}
          disabled={disabled}
          onClick={() => onChange(value)}
        >
          {value === "chat" ? "Chat" : "Code"}
        </button>
      ))}
    </div>
  );
}
