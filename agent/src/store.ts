import type { AgentEvent, AgentState } from "../../lib/protocol/index.ts";

const MAX_EVENTS = 60;

type Listener = (state: AgentState, seq: number) => void;

/** Single source of truth for what the agent reports. Mutations bump `seq`. */
export class Store {
  #state: AgentState;
  #seq = 0;
  #listeners = new Set<Listener>();
  #now: () => number;

  constructor(initial: AgentState, now: () => number = Date.now) {
    this.#state = initial;
    this.#now = now;
  }

  get state(): AgentState {
    return this.#state;
  }

  get seq(): number {
    return this.#seq;
  }

  update(mutate: (draft: AgentState) => void): void {
    const next = structuredClone(this.#state);
    mutate(next);
    this.#state = next;
    this.#seq += 1;
    for (const l of this.#listeners) l(this.#state, this.#seq);
  }

  log(level: AgentEvent["level"], message: string): void {
    this.update((s) => {
      s.events = [{ at: this.#now(), level, message }, ...s.events].slice(0, MAX_EVENTS);
    });
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
