import { describeReason, extractReasonCode } from "../lib/status";

// Reason code in monospace next to its plain-language sentence, from the
// single `REASON_DESCRIPTIONS` mapping. Unknown codes keep the raw text
// with a fallback sentence so new contract reasons stay visible.
export default function ReasonText({
  reason,
}: {
  reason: string | null | undefined;
}) {
  if (typeof reason !== "string" || reason.trim() === "") return null;
  const code = extractReasonCode(reason);
  return (
    <span>
      <code className="rounded bg-slate-800 px-1 py-0.5 text-sky-200">{code}</code>{" "}
      <span className="text-slate-300">{describeReason(reason)}</span>
    </span>
  );
}
