import type { LucideIcon } from "lucide-react";

interface IconButtonProps {
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick?: () => void;
  readonly shortcut?: string;
}

export function IconButton({
  active = false,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  shortcut,
}: IconButtonProps) {
  const unavailable = onClick === undefined;
  const title = unavailable
    ? `${label} (Not available in prototype)`
    : shortcut === undefined
      ? label
      : `${label} (${shortcut})`;
  return (
    <button
      aria-label={label}
      aria-pressed={active || undefined}
      className="icon-button"
      data-active={active || undefined}
      disabled={disabled || unavailable}
      onClick={onClick}
      title={title}
      type="button"
    >
      <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
    </button>
  );
}
