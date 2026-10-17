"use client";

import { useState } from "react";
import type { AgentState, Command } from "@/lib/protocol";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { LINK_TEXT, ago, clock } from "./format";
import { ErrorNote, Fact, Status } from "./bits";

type Send = (c: Command) => Promise<unknown>;

export function PeerPanel({ state, send, now }: { state: AgentState; send: Send; now: number }) {
  const { peer } = state;
  const [confirmForget, setConfirmForget] = useState(false);
  const pairing = peer.pairing && peer.pairing.expiresAt > now ? peer.pairing : null;

  return (
    <section aria-labelledby="peer-heading" className="rise bg-surface-1 p-6 sm:p-8" style={{ "--i": 0 } as React.CSSProperties}>
      <h2 id="peer-heading" className="text-title leading-tight font-semibold tracking-[-0.03em]">
        {peer.link === "unpaired" ? "Pair your laptop" : (peer.name ?? "Laptop")}
      </h2>

      {peer.link === "unpaired" ? (
        pairing ? (
          <div className="mt-6">
            <p className="text-lg text-ink-2">Type this code into the agent on the laptop. It works once and expires at {clock(pairing.expiresAt)}.</p>
            <p className="mt-6 text-target leading-none font-semibold tracking-[0.04em]" aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}>
              {pairing.code.slice(0, 3)}&thinsp;{pairing.code.slice(3)}
            </p>
            <button type="button" onClick={() => send({ type: "pairing.cancel" })} className="press mt-8 h-11 bg-ground px-5 font-medium hover:bg-surface-2">
              Cancel pairing
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <p className="max-w-[52ch] text-lg text-ink-2">
              Pairing lets only your laptop control and stream to this PC. Nothing on the network is trusted until you pair it with a one-time code.
            </p>
            <button type="button" onClick={() => send({ type: "pairing.begin" })} className="press mt-8 h-12 bg-ink px-6 text-lg font-medium text-ground hover:opacity-90">
              Show pairing code
            </button>
          </div>
        )
      ) : (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
            <Fact term="Network link">
              <Status tone={peer.link === "online" ? "live" : peer.link === "connecting" ? "warn" : "danger"} busy={peer.link === "connecting"}>
                {LINK_TEXT[peer.link]}
              </Status>
            </Fact>
            <Fact term="Address">{peer.address ?? "Unknown"}</Fact>
            <Fact term="Last heard from">{ago(peer.lastSeenAt, now)}</Fact>
          </dl>
          {peer.link !== "online" && peer.error ? <ErrorNote error={peer.error} className="mt-6" /> : null}
          <button type="button" onClick={() => setConfirmForget(true)} className="press mt-8 h-11 bg-ground px-5 font-medium hover:bg-surface-2">
            Unpair this laptop
          </button>
        </>
      )}

      <Dialog open={confirmForget} onOpenChange={setConfirmForget}>
        <DialogContent>
          <DialogTitle>Unpair {peer.name ?? "the laptop"}?</DialogTitle>
          <DialogDescription>
            Input returns to the Gaming PC, both audio routes stop, and the laptop must be paired again with a new code.
          </DialogDescription>
          <DialogFooter>
            <DialogClose className="press h-10 bg-surface-1 px-4 font-medium hover:bg-surface-2">Keep paired</DialogClose>
            <button
              type="button"
              onClick={async () => {
                setConfirmForget(false);
                await send({ type: "peer.forget" });
              }}
              className="press h-10 bg-danger px-4 font-medium text-ground"
            >
              Unpair
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function Activity({ state }: { state: AgentState }) {
  const events = state.events.slice(0, 14);
  return (
    <section aria-labelledby="activity-heading" className="rise p-6 sm:p-8" style={{ "--i": 1 } as React.CSSProperties}>
      <h2 id="activity-heading" className="text-title leading-tight font-semibold tracking-[-0.03em]">
        What the agent did
      </h2>
      {events.length === 0 ? (
        <p className="mt-4 text-ink-2">Nothing yet.</p>
      ) : (
        <ol className="mt-6 space-y-3" aria-live="polite">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="grid grid-cols-[4.5rem_1fr] gap-4">
              <time dateTime={new Date(e.at).toISOString()} className="text-ink-2">
                {clock(e.at)}
              </time>
              <span className={e.level === "error" ? "text-danger" : e.level === "warn" ? "text-warn" : undefined}>{e.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
