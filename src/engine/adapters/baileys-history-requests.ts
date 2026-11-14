import type { HistoryAnchor, HistoryAnswer } from '../interfaces/whatsapp-engine.interface';

/** How long after the last batch of an answer the answer is taken as complete (a large one can come in chunks). */
export const DEFAULT_SETTLE_MS = 3_000;
/** An answer nobody waited for is dropped after this long. */
const STALE_MS = 5 * 60_000;

interface Entry {
  /** A batch has arrived, even an empty one: the phone answered. */
  seen: boolean;
  messages: number;
  oldest: HistoryAnchor | null;
  resolve?: (a: HistoryAnswer) => void;
  waitTimer?: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
  staleTimer?: NodeJS.Timeout;
}

/**
 * Pairs a request for older history with its answer.
 *
 * WhatsApp answers an on-demand request through the ordinary history sync, tagged with the id the request
 * returned (`peerDataRequestSessionId`). The sync handler reports each batch here after it has been stored
 * (so its attachment references are kept before the caller moves on), and the request resolves once the
 * answer has stopped arriving, saying how many messages it held and which was the oldest, which is where the
 * next request starts. An answer that never comes resolves unanswered after `waitMs`.
 */
export class BaileysHistoryRequests {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly settleMs = DEFAULT_SETTLE_MS) {}

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { seen: false, messages: 0, oldest: null };
      this.entries.set(id, e);
      // An answer can land before its request has returned: kept for a while, then forgotten.
      e.staleTimer = setTimeout(() => this.entries.delete(id), STALE_MS);
      e.staleTimer.unref?.();
    }
    return e;
  }

  /** One batch of an answer, stored. `requestId` is absent for ordinary syncs, which are ignored. */
  noteBatch(requestId: string | null | undefined, messages: HistoryAnchor[]): void {
    if (!requestId) return;
    const e = this.entry(requestId);
    e.seen = true;
    e.messages += messages.length;
    for (const m of messages) {
      if (!e.oldest || m.timestamp < e.oldest.timestamp) e.oldest = m;
    }
    if (e.resolve) this.armSettle(requestId, e);
  }

  private armSettle(id: string, e: Entry): void {
    clearTimeout(e.settleTimer);
    e.settleTimer = setTimeout(() => this.finish(id), this.settleMs);
    e.settleTimer.unref?.();
  }

  private finish(id: string): void {
    const e = this.entries.get(id);
    if (!e?.resolve) return;
    clearTimeout(e.waitTimer);
    clearTimeout(e.settleTimer);
    clearTimeout(e.staleTimer);
    this.entries.delete(id);
    const resolve = e.resolve;
    e.resolve = undefined;
    resolve({ requestId: id, answered: e.seen, messages: e.messages, oldest: e.oldest });
  }

  /** Send a request and wait for its answer, up to `waitMs`. `send` returns WhatsApp's id for the request. */
  async request(send: () => Promise<string>, waitMs: number): Promise<HistoryAnswer> {
    const id = await send();
    const e = this.entry(id);
    return new Promise<HistoryAnswer>(resolve => {
      e.resolve = resolve;
      e.waitTimer = setTimeout(() => this.finish(id), waitMs);
      e.waitTimer.unref?.();
      if (e.seen) this.armSettle(id, e);
    });
  }

  /** Stop waiting on everything (the engine is closing). */
  close(): void {
    for (const id of [...this.entries.keys()]) {
      const e = this.entries.get(id);
      if (e?.resolve) this.finish(id);
      else {
        clearTimeout(e?.staleTimer);
        this.entries.delete(id);
      }
    }
  }
}
