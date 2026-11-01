/**
 * LinkedIn writes, recorded rather than guessed.
 *
 * LinkedIn's GraphQL writes are unversioned and their shapes move without notice, so this module
 * never authors a mutation: the page recorder watches one real action made through the visible UI,
 * and this file replays exactly that request — method, path, body — with the session's own csrf
 * token and credentials. Templating exists for the one transformation a reply needs (swap the
 * outgoing text); anything the template does not explain is refused, so the caller records a fresh
 * action instead of sending something this code does not understand.
 *
 * Nothing here is wired to the RPC surface. Recording and replaying are separate steps the owner
 * drives, and the first real send is verified by hand.
 *
 * The page expressions are strings evaluated by `evaluateInLinkedInProfile`; the parsing,
 * validation, and substitution happen here in TypeScript so they are testable without a browser.
 */

/** One observed write. Headers are deliberately absent: they carry the session and are re-derived. */
export type RecordedWrite = {
  method: string;
  /** Same-origin path, `/voyager/api/...`; the page strips its own origin so a template names no host. */
  url: string;
  /** The body bytes LinkedIn sent, unchanged. */
  body: string;
  capturedAt: number;
};

/** One bound shared by the page recorder, the transport, and the tests. */
export const LINKEDIN_WRITE_LIMIT = 128 * 1024;

/** The bound counts UTF-8 bytes, so a body of multi-byte text cannot slip past it on length alone. */
export function writeBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Recorded writes the page keeps; older ones are dropped so the page never grows a log. */
export const LINKEDIN_WRITE_KEEP = 5;

/** The only methods a replay may carry. A recorded GET is a read and is never replayed as a write. */
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type ReplayResult = { ok: boolean; status: number; body: unknown };

const pageExpression = (body: string) => `(() => {${body}})()`;

/**
 * Arms the recorder: wraps `window.fetch` and `XMLHttpRequest.send` once, keeps at most
 * `LINKEDIN_WRITE_KEEP` same-origin writes to `/voyager/api/`, and never changes what the page's own
 * call does — the wrapper calls through first and its bookkeeping is swallowed.
 *
 * Both transports are wrapped because a web app may capture either one at boot, and this must work
 * whether it is installed before the app starts or after.
 */
export function writeRecorderExpression(): string {
  return pageExpression(`
    const INSTALLED = Symbol.for('unifiedInbox.writeRecorder');
    if (window[INSTALLED]) return { installed: true, recording: true };
    const LIMIT = ${LINKEDIN_WRITE_LIMIT};
    const KEEP = ${LINKEDIN_WRITE_KEEP};
    // The wrapper closes over this array, so clearing it must empty it in place rather than replace it.
    const list = Array.isArray(window.__unifiedInboxWrites) ? window.__unifiedInboxWrites : (window.__unifiedInboxWrites = []);
    // A recorded write keeps a path, not a host: replay runs in this same page, and a template that
    // carries no origin can never be replayed somewhere else.
    const pathOf = url => {
      const text = String(url);
      const origin = String(location.origin);
      if (origin && text.startsWith(origin + '/voyager/api/')) return text.slice(origin.length);
      return text.startsWith('/voyager/api/') ? text : '';
    };
    const seen = window.__unifiedInboxSeen || (window.__unifiedInboxSeen = { fetch: 0, xhr: 0, considered: 0, skipped: {} });
    const skip = reason => { seen.skipped[reason] = (seen.skipped[reason] || 0) + 1; };
    const capture = (input, init) => {
      seen.considered += 1;
      const requested = init && typeof init.method === 'string' ? init.method : input && typeof input === 'object' && typeof input.method === 'string' ? input.method : 'GET';
      const method = String(requested).toUpperCase();
      if (method === 'GET' || method === 'HEAD') return skip('read');
      const path = pathOf(typeof input === 'string' ? input : input && typeof input === 'object' ? input.url : '');
      if (!path) return skip('path');
      // Only a body the page handed us as a string can be recorded byte for byte; a stream or blob
      // is left alone rather than described by guesswork.
      const body = init && typeof init.body === 'string' ? init.body : '';
      if (!body) return skip('no-body');
      if (new TextEncoder().encode(body).length > LIMIT) return skip('too-big');
      // Counted on both sides of the push: a write that passes every filter and still never lands is
      // a different bug from one the filters reject, and "no writes" hides which.
      seen.pushed = (seen.pushed || 0) + 1;
      seen.last = method + ' ' + path;
      try {
        list.push({ method, url: path, body, capturedAt: Date.now() });
        while (list.length > KEEP) list.shift();
        seen.stored = list.length;
      } catch (error) {
        skip('store-failed');
      }
    };
    const original = window.fetch;
    window.fetch = function (input, init) {
      try { seen.fetch += 1; capture(input, init); } catch (error) { /* the page's own call is not the recorder's to break */ }
      return original.apply(this, arguments);
    };
    // XHR carries no init object, so the method and url are remembered at open() and the body at send().
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR && typeof XHR.send === 'function') {
      const open = XHR.open;
      const send = XHR.send;
      XHR.open = function (method, url) {
        try { this.__unifiedInboxOpen = { method, url }; } catch (error) { /* recorded below as absent */ }
        return open.apply(this, arguments);
      };
      XHR.send = function (body) {
        try { seen.xhr += 1;
          const opened = this.__unifiedInboxOpen;
          if (opened) capture(opened.url, { method: opened.method, body });
        } catch (error) { /* same rule: never break the page's call */ }
        return send.apply(this, arguments);
      };
    }
    Object.defineProperty(window, INSTALLED, { value: true });
    return { installed: true, recording: true };
  `);
}

/**
 * What the wrappers have seen, apart from the writes they accepted: a page whose app captured its own
 * transport shows zero here, while a filter that is too strict shows calls with a skip reason.
 */
export function recorderStatsExpression(): string {
  return pageExpression(`
    const seen = window.__unifiedInboxSeen;
    if (!seen) return null;
    return {
      fetch: seen.fetch || 0,
      xhr: seen.xhr || 0,
      considered: seen.considered || 0,
      skipped: seen.skipped || {},
      pushed: seen.pushed || 0,
      stored: Array.isArray(window.__unifiedInboxWrites) ? window.__unifiedInboxWrites.length : 0,
      last: seen.last || '',
      same: Array.isArray(window.__unifiedInboxWrites),
    };
  `);
}

/**
 * A copy of what is stored, newest first, under `writes`. The page's own array is not handed out, and
 * the wrapper is deliberately not bare: the caller reads `writes` off an object, so a bare array
 * arrives as `undefined` and reads back as "nothing recorded" while the buffer is full.
 */
export function recordedWritesExpression(): string {
  return pageExpression(`
    const list = Array.isArray(window.__unifiedInboxWrites) ? window.__unifiedInboxWrites : [];
    return { writes: list.slice().reverse().map(write => ({
      method: String(write.method),
      url: String(write.url),
      body: String(write.body),
      capturedAt: Number(write.capturedAt) || 0,
    })) };
  `);
}

/** Empties the recorder in place, so the armed wrapper keeps writing to the same array. */
export function clearRecordedWritesExpression(): string {
  return pageExpression(`
    const list = window.__unifiedInboxWrites;
    if (!Array.isArray(list)) return { cleared: 0 };
    const cleared = list.length;
    list.length = 0;
    return { cleared };
  `);
}

/**
 * A same-origin `/voyager/api/...` path, or null. Anything else is refused rather than escaped:
 * this value is interpolated into page code, and a template that does not look like a LinkedIn
 * API path has no business being replayed.
 */
export function voyagerWritePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  // A scheme, an absolute URL, or any control character is not a path on this origin.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  if (!value.startsWith('/voyager/api/')) return null;
  // `%2e` would decode to a traversal segment at the transport layer; refuse it whole.
  if (/%2e/i.test(value)) return null;
  const path = value.split('?')[0].split('#')[0].split('/');
  if (path.includes('..') || path.includes('.')) return null;
  return value;
}

function writeMethod(value: unknown): string | null {
  const method = typeof value === 'string' ? value.toUpperCase() : '';
  return (WRITE_METHODS as readonly string[]).includes(method) ? method : null;
}

/**
 * Replays one recorded write from the page, with the live `csrf-token` read from the session — the
 * same way the reads do it — so nothing from the recording's own session is reused. A non-2xx
 * answer is reported, not thrown: the caller decides whether the effect landed.
 */
/** Decodes a urn that arrived percent-encoded in a query string, leaving one that did not untouched. */
function decodedUrn(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when two conversation ids name the same conversation, however they were encoded. */
export function sameConversationUrn(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return decodedUrn(left).trim() === decodedUrn(right).trim();
}

/**
 * The conversation a recorded mark-read addresses, or null when the write is not that shape.
 *
 * Marking read turned out not to be a GraphQL mutation at all: LinkedIn patches one entity —
 * `{ entities: { <urn>: { patch: { $set: { read: true } } } } }` — at
 * `/voyager/api/voyagerMessagingDashMessengerConversations?ids=List(<urn>)`. The recogniser accepts
 * exactly that and nothing looser, so a request that would change anything else is refused rather
 * than replayed.
 */
export function markReadTarget(write: RecordedWrite): string | null {
  if (!write || typeof write.method !== 'string' || write.method.toUpperCase() !== 'POST') return null;
  if (typeof write.url !== 'string' || typeof write.body !== 'string') return null;
  const query = write.url.indexOf('?');
  if (query < 0) return null;
  if (write.url.slice(0, query) !== '/voyager/api/voyagerMessagingDashMessengerConversations') return null;
  const ids = new URLSearchParams(write.url.slice(query + 1)).get('ids') ?? '';
  const listed = /^List\((.+)\)$/.exec(ids);
  if (!listed) return null;
  // The urn is compared, never interpolated — the replay re-sends the recorded url and body — so it
  // is checked for being a conversation id, not for a shape this code would build.
  const urn = decodedUrn(listed[1]);
  if (!isConversationUrn(urn)) return null;
  let body: unknown;
  try {
    body = JSON.parse(write.body);
  } catch {
    return null;
  }
  const entities = (body as { entities?: unknown })?.entities;
  if (!entities || typeof entities !== 'object' || Array.isArray(entities)) return null;
  const keys = Object.keys(entities);
  if (keys.length !== 1 || !sameConversationUrn(keys[0], urn)) return null;
  const patch = (entities as Record<string, { patch?: unknown }>)[keys[0]]?.patch;
  if (!patch || typeof patch !== 'object') return null;
  const set = (patch as { $set?: unknown }).$set;
  if (!set || typeof set !== 'object') return null;
  const changed = Object.keys(set);
  if (changed.length !== 1 || changed[0] !== 'read') return null;
  return (set as Record<string, unknown>).read === true ? urn : null;
}

/**
 * The mark-read request for one conversation, built from the shape observed on 2026-11-02: a REST
 * patch of a single entity at `/voyagerMessagingDashMessengerConversations?ids=List(<urn>)` whose
 * body sets exactly `read`. The url percent-encodes the urn the same way the observed request did,
 * and the body stringifies the patch rather than interpolating it, so a malformed urn is refused by
 * `isConversationUrn` before anything is built — never escaped into a request.
 */
export function markReadWrite(conversationId: unknown, read: boolean): RecordedWrite | null {
  if (!isConversationUrn(conversationId)) return null;
  const urn = String(conversationId);
  return {
    method: 'POST',
    // LinkedIn encoded the parentheses too, so the url matches the observed request byte for byte
    // rather than merely decoding to the same thing.
    url: `/voyager/api/voyagerMessagingDashMessengerConversations?ids=List(${encodeURIComponent(urn).replace(/\(/g, '%28').replace(/\)/g, '%29')})`,
    body: JSON.stringify({ entities: { [urn]: { patch: { $set: { read } } } } }),
    capturedAt: 0,
  };
}

export function replayWriteExpression(write: RecordedWrite): string {
  const method = writeMethod(write?.method);
  if (!method) throw new Error(`A recorded write must be one of ${WRITE_METHODS.join(', ')}; got ${String(write?.method)}.`);
  const url = voyagerWritePath(write.url);
  if (!url) throw new Error(`A recorded write must replay a same-origin /voyager/api/ path; got ${String(write?.url)}.`);
  if (typeof write.body !== 'string') throw new Error('A recorded write must carry the body string LinkedIn sent.');
  if (writeBytes(write.body) > LINKEDIN_WRITE_LIMIT) throw new Error(`A recorded write body must be at most ${LINKEDIN_WRITE_LIMIT} bytes.`);
  try {
    JSON.parse(write.body);
  } catch {
    throw new Error('A recorded write body must be JSON, exactly as LinkedIn sent it.');
  }
  return `(async () => {
  try {
    const pair = (document.cookie.split('; ').find(c => c.startsWith('JSESSIONID=')) || '').split('=')[1] || '';
    const headers = {
      'csrf-token': decodeURIComponent(pair).replace(/^"|"$/g, ''),
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0',
      'content-type': 'application/json',
    };
    const response = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers, body: ${JSON.stringify(write.body)}, credentials: 'include' });
    const text = await response.text();
    let payload = text;
    try { payload = JSON.parse(text); } catch (error) { /* a non-JSON answer is reported as the text it was */ }
    return { ok: response.ok, status: response.status, body: payload };
  } catch (error) {
    return { ok: false, status: 0, body: { error: String((error && error.message) || error).split(String.fromCharCode(10))[0] } };
  }
})()`;
}

type Path = Array<string | number>;
type TextField = { path: Path; value: string };

/** A conversation urn is the only id this module will template against. */
const CONVERSATION_URN = /^urn:li:msg_conversation:\S+$/;

function isConversationUrn(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_URN.test(value);
}

function parsedBody(write: RecordedWrite): Record<string, unknown> | null {
  if (!write || typeof write.body !== 'string') return null;
  try {
    const value: unknown = JSON.parse(write.body);
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Every string leaf, with the path that reaches it. */
function strings(value: unknown, path: Path, visit: (text: string, path: Path) => void): void {
  if (typeof value === 'string') { visit(value, path); return; }
  if (Array.isArray(value)) { value.forEach((item, index) => strings(item, [...path, index], visit)); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) strings(item, [...path, key], visit);
  }
}

/** The string fields named `text`: the only place this module replaces a value. */
function textFields(value: unknown): TextField[] {
  const found: TextField[] = [];
  strings(value, [], (text, path) => {
    if (path.at(-1) === 'text') found.push({ path, value: text });
  });
  return found;
}

function carriesConversation(value: unknown, conversationId: string): boolean {
  let found = false;
  strings(value, [], text => { if (text.includes(conversationId)) found = true; });
  return found;
}

function setAt(root: unknown, path: Path, value: string): void {
  let cursor: any = root;
  for (const key of path.slice(0, -1)) cursor = cursor[key];
  cursor[path.at(-1) as string | number] = value;
}

const pathLabel = (path: Path) => path.join('.');

/**
 * Refuses a template captured from a different action. The url, the method, the conversation urn,
 * and exactly one text field all have to agree; anything else means this is not a message send
 * this module can reason about.
 */
export function isMessageSend(write: RecordedWrite, conversationId: string): boolean {
  if (!write || !writeMethod(write.method) || !voyagerWritePath(write.url)) return false;
  if (!isConversationUrn(conversationId)) return false;
  const body = parsedBody(write);
  if (!body) return false;
  return carriesConversation(body, conversationId) && textFields(body).length === 1;
}

/**
 * The text a recorded send carried, so a replay that supplies no replacement repeats exactly what
 * was recorded instead of blanking the message. Null when the template has no single text field.
 */
export function recordedSendText(write: RecordedWrite, conversationId: string): string | null {
  const body = parsedBody(write);
  if (!body) return null;
  if (!carriesConversation(body, conversationId)) return null;
  const fields = textFields(body);
  return fields.length === 1 ? fields[0].value : null;
}

/**
 * The same recorded send, carrying `text`. Works on the parsed JSON and replaces only the one
 * outgoing text field, so every other field travels byte for byte as LinkedIn wrote it.
 *
 * A template that does not name this conversation, or names no text field or more than one, is
 * refused with the reason: the caller records the action again rather than sending a guess.
 */
export function messageSendTemplate(write: RecordedWrite, conversationId: string, text: string): RecordedWrite {
  if (!isConversationUrn(conversationId)) throw new Error(`A template needs a LinkedIn conversation urn; got ${String(conversationId)}.`);
  if (typeof text !== 'string') throw new Error('A message template needs the text to send.');
  const body = parsedBody(write);
  if (!body) throw new Error('A template needs the JSON body LinkedIn sent; this recorded write has none.');
  if (!carriesConversation(body, conversationId)) {
    throw new Error(`The recorded write does not carry the conversation urn ${conversationId}, so it is not a send to this conversation.`);
  }
  const fields = textFields(body);
  if (fields.length !== 1) {
    const where = fields.map(field => pathLabel(field.path)).join(', ');
    throw new Error(fields.length === 0
      ? 'The recorded write has no text field to replace, so it is not a message send.'
      : `The recorded write has ${fields.length} text fields (${where}); cannot tell which one is the outgoing message.`);
  }
  setAt(body, fields[0].path, text);
  return { ...write, body: JSON.stringify(body) };
}
