// Where a WhatsApp picture comes from (INBOX-29).
//
// A picture is the one fact about a chat that the store cannot already hold: it has to be asked for,
// and asking is a network call. So the read is split in two. `url(jid)` answers what the store knows,
// synchronously and without a socket; a jid the store does not know — or knows from longer ago than
// `AVATAR_TTL_MS` — is queued and asked in the background, so a row draws initials on the draw it
// first appears and its picture on the next one. That is the same bargain `src/whatsapp/media.ts`
// makes with its state machine, and it is why no list call waits on WhatsApp.
//
// Four rules live here and nowhere else:
//   - only an open socket is asked. `ensure()` is deliberately not called: a picture is not worth a
//     reconnect, and `src/whatsapp/lifecycle.ts` alone decides when a socket exists.
//   - "no picture" is an answer, not a failure. It is recorded as `failed` and drawn as initials, and
//     asked again only after `AVATAR_RETRY_MS` — a person can set one later, and a socket that
//     blipped must not hide a face all day.
//   - one ask per jid, and one jid at a time. The panel draws a page of rows at once, and a burst of
//     IQs is what gets an account throttled; the queue costs nothing because nothing waits on it.
//   - a stored URL is answered even past its TTL. It usually still loads, and the panel's own
//     `onError` turns a dead one back into initials (`app.tsx`), so blanking a picture to refresh it
//     is strictly worse than showing a stale one.
import type { Avatar, AvatarState, WhatsAppStore } from './store.ts';
import type { WhatsAppAvatarSocket } from './connection.ts';

/** How long a picture URL is trusted before it is asked for again — WhatsApp's links expire in days. */
export const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
/** How long "there is no picture" is trusted, so a redraw of the same page is not a burst of asks. */
export const AVATAR_RETRY_MS = 60 * 60 * 1000;
/** A single ask's ceiling: a wedged IQ must not hold the queue behind it. */
export const AVATAR_ASK_TIMEOUT_MS = 8_000;

export type WhatsAppAvatarsOptions = {
  store: WhatsAppStore;
  /** The open socket, when there is one. Absent is a state, not an error: the store still answers. */
  socket: () => WhatsAppAvatarSocket | undefined;
  /** Injected for tests; the TTL is otherwise measured against the wall clock. */
  now?: () => number;
};

export function createWhatsAppAvatars(options: WhatsAppAvatarsOptions) {
  const { store } = options;
  const clock = options.now ?? Date.now;
  /** Jids waiting for an ask, in the order a page drew them. */
  const queue: string[] = [];
  /** Jids queued or being asked right now, so two draws of one page ask once. */
  const inFlight = new Set<string>();
  let draining = false;

  /** Whether what the store holds is older than this answer can be trusted. */
  const stale = (avatar: Avatar | undefined, now: number): boolean => {
    if (!avatar || avatar.fetched_at === null) return true;
    const age = now - avatar.fetched_at;
    return avatar.state === 'ready' ? age > AVATAR_TTL_MS : age > AVATAR_RETRY_MS;
  };

  /**
   * Ask for one picture, once. Sequential by construction: a drain that is already running picks the
   * new jid up when it reaches it, so a page of fifty rows is fifty asks in a row, not fifty at once.
   */
  function enqueue(jid: string): void {
    if (!jid || inFlight.has(jid) || !options.socket()) return;
    inFlight.add(jid);
    queue.push(jid);
    // A picture is a nicety beside the row it decorates: a drain that fails somewhere unexpected is
    // dropped rather than allowed to surface as an unhandled rejection in a read that never awaited it.
    void drain().catch(() => {});
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const socket = options.socket();
        // A socket that closed mid-page drops the rest of the queue rather than reporting fifty
        // failures: those rows keep what they have, and the next draw asks again.
        if (!socket) break;
        const jid = queue.shift();
        if (jid === undefined) break;
        let state: AvatarState = 'failed';
        let url: string | null = null;
        try {
          url = (await socket.profilePictureUrl(jid, 'preview', AVATAR_ASK_TIMEOUT_MS)) || null;
          state = url ? 'ready' : 'failed';
        } catch {
          // WhatsApp answers a picture it will not hand out — a privacy setting, a stranger — by
          // refusing, and a socket blip refuses the same way. Both are a face it does not have yet:
          // the row records `failed`, nothing is thrown, and it is asked again after the retry window.
        }
        try {
          store.setAvatar({ jid, url, state, fetched_at: clock() });
        } catch {
          /* a picture must never break the read that asked for it */
        }
        inFlight.delete(jid);
      }
    } finally {
      // Whatever is left was not asked (no socket), so it must be askable again on the next draw.
      for (const jid of queue) inFlight.delete(jid);
      queue.length = 0;
      draining = false;
    }
  }

  return {
    /**
     * What the store knows about a chat's picture, answered now. A row the store has nothing for — or
     * something too old to trust — is asked for in the background, so this call is a store read and
     * never a wait.
     */
    url(jid: string): string | undefined {
      const avatar = store.getAvatar(jid);
      if (stale(avatar, clock())) enqueue(jid);
      return avatar?.state === 'ready' && avatar.url ? avatar.url : undefined;
    },
  };
}

export type WhatsAppAvatars = ReturnType<typeof createWhatsAppAvatars>;
