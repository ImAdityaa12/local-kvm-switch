"use client";

import { useState } from "react";
import type { AgentState, Command, SharingState } from "@/lib/protocol";
import { Switch } from "@/components/ui/switch";
import { ErrorNote, Fact, Status } from "./bits";

type Send = (c: Command) => Promise<unknown>;

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function DriveStatus({ files, other }: { files: SharingState["files"]; other: string }) {
  const r = files.remote;
  if (r.status === "mounted" && r.letter) return <Status tone="live">On {r.letter}:</Status>;
  if (r.status === "mounting") return <Status tone="warn" busy>Connecting</Status>;
  if (r.status === "error") return <Status tone="danger">Failed</Status>;
  if (files.missing.length) return <Status tone="idle">Needs setup</Status>;
  return <Status tone="idle">{r.offered ? "Not connected" : `${other} does not offer its drives`}</Status>;
}

/** The clipboard both ways, and each machine's drives on the other. */
export function SharingPanel({ state, send, now }: { state: AgentState; send: Send; now: number }) {
  const sharing = state.sharing;
  const [opening, setOpening] = useState(false);
  // An older agent.
  if (!sharing) return null;
  const { clipboard, files } = sharing;
  const onLaptop = state.agent.machine === "laptop";
  const other = state.peer.name ?? (onLaptop ? "the gaming PC" : "the laptop");
  const otherRole = onLaptop ? "Gaming PC" : "Laptop";
  const mounted = files.remote.status === "mounted" && files.remote.letter;
  const open = async () => {
    setOpening(true);
    try {
      await send({ type: "files.open" });
    } finally {
      setOpening(false);
    }
  };

  return (
    <section aria-labelledby="sharing-heading" className="rise mt-28 grid gap-2 md:mt-40 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" style={{ "--i": 3 } as React.CSSProperties}>
      <div>
        <h2 id="sharing-heading" className="text-title leading-tight font-semibold tracking-[-0.03em]">
          Clipboard and files
        </h2>
        <p className="mt-3 max-w-[52ch] text-lg text-ink-2">
          Copy on one machine, paste on the other. The other machine&apos;s drives show here as a drive in Explorer and in every app&apos;s Open and Save dialogs. Everything goes over the paired link only.
        </p>
      </div>

      <div className="grid gap-2">
        <div className="flex items-start justify-between gap-6 bg-surface-1 px-5 py-5 sm:px-6">
          <div className="min-w-0">
            <label htmlFor="share-clipboard" className="text-lg font-semibold">
              Share the clipboard
            </label>
            <p className="mt-1 max-w-[70ch] text-ink-2">
              Text, formatted text and images cross as you copy them. Copied files are pasted from the other machine&apos;s drive, so it must offer its drives. Copies a password manager marks as private stay on this PC.
            </p>
            <p className="mt-2 text-sm text-ink-2">
              {!clipboard.available
                ? "The clipboard helper is not running on this PC. Run npm.cmd run build:audio and restart the agent."
                : clipboard.last
                  ? `Last: ${clipboard.last.what} ${clipboard.last.direction === "sent" ? `sent to ${other}` : `from ${other}`}, ${ago(clipboard.last.at, now)}.`
                  : "Nothing has crossed yet."}
            </p>
          </div>
          <Switch
            id="share-clipboard"
            checked={clipboard.enabled}
            onCheckedChange={(enabled) => send({ type: "sharing.setClipboard", enabled })}
            className="data-checked:bg-live mt-1.5 scale-125"
          />
        </div>

        <div className="flex items-start justify-between gap-6 bg-surface-1 px-5 py-5 sm:px-6">
          <div className="min-w-0">
            <label htmlFor="share-files" className="text-lg font-semibold">
              Share this PC&apos;s drives
            </label>
            <p className="mt-1 max-w-[70ch] text-ink-2">
              Lets {other} open, change and save files on every local drive of this PC, as the signed-in Windows user. Turn it off and they disappear from {other} at once.
            </p>
            {files.serving ? <p className="mt-2 text-sm text-ink-2">Offering {files.serving.map((d) => `${d}:`).join(", ")}</p> : null}
          </div>
          <Switch
            id="share-files"
            checked={files.enabled}
            onCheckedChange={(enabled) => send({ type: "sharing.setFiles", enabled })}
            className="data-checked:bg-live mt-1.5 scale-125"
          />
        </div>

        {files.missing.length ? (
          <div role="note" className="bg-warn-field px-5 py-4 sm:px-6">
            <p className="font-semibold">
              {files.missing.includes("rclone") ? "rclone" : ""}
              {files.missing.length === 2 ? " and " : ""}
              {files.missing.includes("winfsp") ? "WinFsp" : ""} {files.missing.length === 2 ? "are" : "is"} not installed on this PC
            </p>
            <p className="mt-0.5 text-ink-2">
              {files.missing.includes("rclone") ? "Without rclone, this PC cannot offer its drives or show the other machine's. " : "Without WinFsp, the other machine's drives cannot show here as a drive letter. "}
              In the project folder, run <code>npm.cmd run setup:files</code> once (Windows asks for permission to install). The agent notices within 15 s.
            </p>
          </div>
        ) : null}

        {files.remote.error && files.remote.status === "error" ? <ErrorNote error={files.remote.error} /> : null}

        <div className="flex flex-wrap items-end justify-between gap-6 bg-surface-1 px-5 py-5 sm:px-6">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-5">
            <Fact term={`${otherRole}'s drives`}>
              <DriveStatus files={files} other={other} />
            </Fact>
            <Fact term="Clipboard helper">
              <Status tone={clipboard.available ? "live" : "idle"}>{clipboard.available ? "Running" : "Not running"}</Status>
            </Fact>
          </dl>
          <button
            type="button"
            onClick={open}
            disabled={!mounted || opening || state.agent.simulated}
            className="press h-11 bg-surface-2 px-5 font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mounted ? `Open ${files.remote.letter}: in Explorer` : "Open in Explorer"}
          </button>
        </div>
      </div>
    </section>
  );
}
