"use client";

import { useState } from "react";
import type { AgentState, Command, PairingState } from "@/lib/protocol";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { LINK_TEXT, ago, clock } from "./format";
import { ErrorNote, Fact, Status } from "./bits";

type Send = (c: Command) => Promise<unknown>;

const quiet = "press h-11 bg-ground px-5 font-medium hover:bg-surface-2";
const loud = "press h-12 bg-ink px-6 text-lg font-medium text-ground hover:opacity-90";

export function PeerPanel({ state, send, now }: { state: AgentState; send: Send; now: number }) {
  const { peer, agent } = state;
  const [confirmForget, setConfirmForget] = useState(false);
  const pairing = peer.pairing && peer.pairing.expiresAt > now ? peer.pairing : null;
  const other = agent.machine === "gaming-pc" ? "laptop" : "gaming PC";

  return (
    <section aria-labelledby="peer-heading" className="rise bg-surface-1 p-6 sm:p-8" style={{ "--i": 0 } as React.CSSProperties}>
      <h2 id="peer-heading" className="text-title leading-tight font-semibold tracking-[-0.03em]">
        {peer.link === "unpaired" ? `Pair your ${other}` : (peer.name ?? `The ${other}`)}
      </h2>

      {peer.link === "unpaired" ? (
        pairing ? (
          <Pairing pairing={pairing} state={state} send={send} />
        ) : (
          <Unpaired state={state} send={send} />
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
          <button type="button" onClick={() => setConfirmForget(true)} className={`${quiet} mt-8`}>
            Unpair this {other}
          </button>
        </>
      )}

      <Dialog open={confirmForget} onOpenChange={setConfirmForget}>
        <DialogContent>
          <DialogTitle>Unpair {peer.name ?? `the ${other}`}?</DialogTitle>
          <DialogDescription>
            Input returns to the Gaming PC, both audio routes stop, and the two machines must be paired again.
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

function Unpaired({ state, send }: { state: AgentState; send: Send }) {
  const [address, setAddress] = useState("");
  if (state.agent.machine === "gaming-pc") {
    return (
      <div className="mt-4">
        <p className="max-w-[52ch] text-lg text-ink-2">
          Pairing lets only your laptop control and stream to this PC. Nothing on the network is trusted until both machines show the same code and you confirm it on both.
        </p>
        {state.peer.error ? <ErrorNote error={state.peer.error} className="mt-6" /> : null}
        <button type="button" onClick={() => send({ type: "pairing.begin" })} className={`${loud} mt-8`}>
          Open pairing for two minutes
        </button>
      </div>
    );
  }
  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (address.trim()) send({ type: "pairing.begin", address: address.trim() });
      }}
    >
      <p className="max-w-[52ch] text-lg text-ink-2">Open pairing on the gaming PC&apos;s dashboard, then enter the address it shows.</p>
      {state.peer.error ? <ErrorNote error={state.peer.error} className="mt-6" /> : null}
      <label htmlFor="pc-address" className="mt-8 block text-sm text-ink-2">
        Gaming PC address
      </label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input
          id="pc-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="192.168.1.20"
          className="h-12 min-w-0 flex-1 border border-input bg-ground px-4 text-lg outline-none focus-visible:border-live"
        />
        <button type="submit" className={loud} disabled={!address.trim()}>
          Pair
        </button>
      </div>
    </form>
  );
}

function Pairing({ pairing, state, send }: { pairing: PairingState; state: AgentState; send: Send }) {
  const other = state.agent.machine === "gaming-pc" ? "laptop" : "gaming PC";
  const cancel = (
    <button type="button" onClick={() => send({ type: "pairing.cancel" })} className={`${quiet} mt-8`}>
      Cancel pairing
    </button>
  );

  if (pairing.stage === "listening") {
    return (
      <div className="mt-6">
        <p className="text-lg text-ink-2">On the laptop, open its dashboard and enter this address. Pairing closes at {clock(pairing.expiresAt)}.</p>
        <p className="mt-6 text-[clamp(2.25rem,4.4vw,4rem)] leading-none font-semibold tracking-[-0.03em] break-all">{pairing.address ?? "this PC's address"}</p>
        <p className="mt-6">
          <Status tone="warn" busy>
            Waiting for the laptop
          </Status>
        </p>
        {cancel}
      </div>
    );
  }

  if (pairing.stage === "connecting") {
    return (
      <div className="mt-6">
        <Status tone="warn" busy>
          Contacting {pairing.address}
        </Status>
        {cancel}
      </div>
    );
  }

  const { code } = pairing;
  return (
    <div className="mt-6">
      <p className="text-lg text-ink-2">
        {pairing.peerName} wants to pair. Check that the {other} shows exactly this code.
      </p>
      <p className="mt-6 text-target leading-none font-semibold tracking-[0.04em]" aria-label={`Pairing code ${code.split("").join(" ")}`}>
        {code.slice(0, 3)}&thinsp;{code.slice(3)}
      </p>
      {pairing.localConfirmed ? (
        <p className="mt-8 text-lg">
          <Status tone="warn" busy>
            Confirmed here. Waiting for the {other} to confirm.
          </Status>
        </p>
      ) : (
        <div className="mt-8 flex flex-wrap gap-2">
          <button type="button" onClick={() => send({ type: "pairing.confirm", accept: true })} className={loud}>
            The codes match
          </button>
          <button type="button" onClick={() => send({ type: "pairing.confirm", accept: false })} className="press h-12 bg-danger-field px-6 text-lg font-medium hover:opacity-80">
            They differ
          </button>
        </div>
      )}
      {pairing.remoteConfirmed && !pairing.localConfirmed ? <p className="mt-4 text-ink-2">The {other} has confirmed.</p> : null}
    </div>
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
