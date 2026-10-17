import { cn } from "@/lib/utils";
import type { AgentError } from "@/lib/protocol";

export type Tone = "live" | "warn" | "danger" | "idle";

const DOT: Record<Tone, string> = {
  live: "bg-live",
  warn: "bg-warn",
  danger: "bg-danger",
  idle: "bg-ink-2/50",
};

/** A status light and its words. The words always carry the meaning; colour only repeats it. */
export function Status({ tone, children, busy = false, className }: { tone: Tone; children: React.ReactNode; busy?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", DOT[tone], busy && "pulse-dot")} />
      <span>{children}</span>
    </span>
  );
}

export function ErrorNote({ error, className }: { error: AgentError; className?: string }) {
  return (
    <div role="alert" className={cn("bg-danger-field px-4 py-3 text-ink", className)}>
      <p className="font-semibold">{error.message}</p>
      {error.hint ? <p className="mt-0.5 text-ink-2">{error.hint}</p> : null}
    </div>
  );
}

export function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-ink-2">{term}</dt>
      <dd className="mt-1 font-medium">{children}</dd>
    </div>
  );
}
