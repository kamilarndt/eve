import { Copy } from "lucide-react";

interface StructuredValueProps {
  readonly value: unknown;
}

export function StructuredValue({ value }: StructuredValueProps) {
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  return (
    <div className="structured-value-container">
      <pre className="structured-value">{serialized}</pre>
      <button
        aria-label="Copy JSON"
        className="structured-value-copy"
        onClick={() => void navigator.clipboard.writeText(serialized)}
        title="Copy JSON"
        type="button"
      >
        <Copy aria-hidden="true" size={13} />
      </button>
    </div>
  );
}
