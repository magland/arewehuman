import { decodeRanges, SRCS, type Ev, type ProvDoc, type Src } from "./format";

export interface CharInfo {
  src: Src;
  tIns: number;
  // Whether the character is a line break: known for inserts that list their
  // line breaks, undefined for those that do not.
  nl?: boolean;
  // For source "k": the recording and character it came from.
  from?: { ref: string; id: number };
  // Later deletions and restorations, in order: [t, "d" | "u" | "m"]
  hist: [number, "d" | "u" | "m"][];
}

export interface ReplayResult {
  live: number[]; // ids in final document order
  chars: CharInfo[]; // indexed by id
  errors: string[];
}

// Applies one event to the live id array. Returns an error message or null.
export function applyEvent(live: number[], chars: CharInfo[], ev: Ev, alive: Uint8Array | boolean[]): string | null {
  switch (ev[0]) {
    case "s":
      return null;
    case "g":
      return typeof ev[2] === "string" && /^[0-9a-f]{40,64}$/.test(ev[2]) ? null : "malformed commit hash";
    case "i": {
      const [, t, pos, n, src, nl] = ev;
      if (!SRCS.includes(src) || src === "k") return `unknown source "${src}"`;
      if (!(pos >= 0 && pos <= live.length) || !(n > 0)) return `insert out of range (pos ${pos}, n ${n}, length ${live.length})`;
      if (nl !== undefined && !(Array.isArray(nl) && nl.length && nl.every((k, j) => Number.isInteger(k) && k >= 0 && k < n && (j === 0 || k > nl[j - 1]))))
        return "malformed list of line breaks";
      const breaks = nl && new Set(nl);
      const ids: number[] = [];
      for (let k = 0; k < n; k++) {
        const id = chars.length;
        chars.push({ src, tIns: t, hist: [], nl: breaks ? breaks.has(k) : undefined });
        alive[id] = true as never;
        ids.push(id);
      }
      spliceIn(live, pos, ids);
      return null;
    }
    case "k": {
      const [, t, pos, ref, ranges, nl] = ev;
      if (typeof ref !== "string" || !ref) return "malformed reference to another recording";
      if (!(pos >= 0 && pos <= live.length)) return `insert out of range (pos ${pos}, length ${live.length})`;
      const from = Array.isArray(ranges) ? decodeRanges(ranges) : [];
      const n = from.length;
      if (!n || !from.every((x) => Number.isInteger(x) && x >= 0)) return "malformed reference to another recording";
      if (nl !== undefined && !(Array.isArray(nl) && nl.length && nl.every((k, j) => Number.isInteger(k) && k >= 0 && k < n && (j === 0 || k > nl[j - 1]))))
        return "malformed list of line breaks";
      const breaks = nl && new Set(nl);
      const ids: number[] = [];
      for (let k = 0; k < n; k++) {
        const id = chars.length;
        chars.push({ src: "k", tIns: t, hist: [], nl: breaks ? breaks.has(k) : undefined, from: { ref, id: from[k] } });
        alive[id] = true as never;
        ids.push(id);
      }
      spliceIn(live, pos, ids);
      return null;
    }
    case "d": {
      const [, t, pos, n] = ev;
      if (!(pos >= 0 && n > 0 && pos + n <= live.length)) return `delete out of range (pos ${pos}, n ${n}, length ${live.length})`;
      const removed = live.splice(pos, n);
      for (const id of removed) {
        chars[id].hist.push([t, "d"]);
        alive[id] = false as never;
      }
      return null;
    }
    case "r": {
      const [, t, pos, kind, ranges] = ev;
      if (kind !== "u" && kind !== "m") return `unknown restore kind "${kind}"`;
      if (!(pos >= 0 && pos <= live.length)) return `restore out of range (pos ${pos}, length ${live.length})`;
      const ids = decodeRanges(ranges);
      if (!ids.length) return "empty restore";
      for (const id of ids) {
        if (!(id >= 0 && id < chars.length)) return `restore of unknown character ${id}`;
        if (alive[id]) return `restore of character ${id}, which is not deleted`;
      }
      for (const id of ids) {
        chars[id].hist.push([t, kind]);
        alive[id] = true as never;
      }
      spliceIn(live, pos, ids);
      return null;
    }
    default:
      return `unknown event type "${(ev as unknown[])[0]}"`;
  }
}

export function spliceIn(arr: number[], pos: number, items: number[]) {
  if (items.length < 10000) arr.splice(pos, 0, ...items);
  else {
    const tail = arr.splice(pos);
    for (const x of items) arr.push(x);
    for (const x of tail) arr.push(x);
  }
}

export function replay(doc: Pick<ProvDoc, "events" | "text">): ReplayResult {
  const live: number[] = [];
  const chars: CharInfo[] = [];
  const alive: boolean[] = [];
  const errors: string[] = [];
  let lastT = -Infinity;
  doc.events.forEach((ev, i) => {
    if (errors.length > 20) return;
    if (!Array.isArray(ev)) {
      errors.push(`event ${i}: not an array`);
      return;
    }
    const t = ev[1];
    if (!Number.isInteger(t)) errors.push(`event ${i}: time is not an integer`);
    else if (t < lastT) errors.push(`event ${i}: time goes backwards`);
    lastT = Math.max(lastT, t);
    const err = applyEvent(live, chars, ev, alive);
    if (err) errors.push(`event ${i}: ${err}`);
  });
  if (!errors.length && live.length !== doc.text.length)
    errors.push(`replay gives ${live.length} characters but the text has ${doc.text.length}`);
  if (!errors.length) {
    const bad = live.findIndex((id, i) => chars[id].nl !== undefined && chars[id].nl !== (doc.text[i] === "\n"));
    if (bad >= 0) errors.push(`the line breaks listed in the log do not match the text (at offset ${bad})`);
  }
  return { live, chars, errors };
}

// Ids-only application of an event, for fast seeking. Assumes the log was validated by replay().
function applyLive(st: { live: number[]; next: number }, ev: Ev) {
  if (ev[0] === "i" || ev[0] === "k") {
    const n = ev[0] === "i" ? ev[3] : decodeRanges(ev[4]).length;
    const ids: number[] = [];
    for (let j = 0; j < n; j++) ids.push(st.next++);
    spliceIn(st.live, ev[2], ids);
  } else if (ev[0] === "d") st.live.splice(ev[2], ev[3]);
  else if (ev[0] === "r") spliceIn(st.live, ev[2], decodeRanges(ev[4]));
}

// Random access to the document state after any number of events, via snapshots.
export class Timeline {
  private snaps: { k: number; live: number[]; next: number }[] = [];
  readonly finalIndex: Int32Array; // id -> index in final text, or -1
  readonly chars: CharInfo[];
  constructor(readonly doc: ProvDoc, readonly res: ReplayResult, every = 1000) {
    this.chars = res.chars;
    this.finalIndex = new Int32Array(res.chars.length).fill(-1);
    res.live.forEach((id, i) => (this.finalIndex[id] = i));
    const st = { live: [] as number[], next: 0 };
    this.snaps.push({ k: 0, live: [], next: 0 });
    doc.events.forEach((ev, i) => {
      applyLive(st, ev);
      if ((i + 1) % every === 0) this.snaps.push({ k: i + 1, live: st.live.slice(), next: st.next });
    });
  }
  // Live ids after the first k events.
  stateAt(k: number): number[] {
    let s = this.snaps[0];
    for (const x of this.snaps) if (x.k <= k) s = x;
    const st = { live: s.live.slice(), next: s.next };
    for (let i = s.k; i < k; i++) applyLive(st, this.doc.events[i]);
    return st.live;
  }
}
