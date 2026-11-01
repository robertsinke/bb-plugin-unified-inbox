import { sameConversationUrn } from './linkedin-write.ts';
/**
 * The LinkedIn page as a person drives it: what is on it, where it is, and which control a call
 * names.
 *
 * The plugin's LinkedIn tab is headless and owned by the plugin, so the only way to act in it is
 * Chrome DevTools Protocol input — `Input.dispatchMouseEvent`, `Input.insertText`,
 * `Input.dispatchKeyEvent`. Those produce trusted events, which LinkedIn's React app accepts,
 * whereas a scripted `el.click()` or a written `el.value` is ignored. This module builds the
 * expressions; `linkedin-chrome.ts` evaluates them and dispatches the input.
 *
 * These expressions return plain values. The `{ok, payload}` envelope is the read module's
 * convention, and a page that has gone away already throws in `evaluateInLinkedInProfile`.
 *
 * Every action names one index from this enumeration, and `isSendControl` is the single rule shared
 * by the transport, the adapter, and the tests that decides which click needs explicit approval.
 */

/** One thing a person could act on, with the position a click needs. */
export type PageControl = {
  /** Position in the enumeration, so a caller clicks by index and never by a remembered rect. */
  index: number;
  role: string;
  /** Accessible name: aria-label, title, the button/link text, a placeholder, or a label's text. */
  name: string;
  tag: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
};

/** Bounds shared by the page expressions, the transport, and the tests. */
export const LINKEDIN_CONTROL_LIMIT = 600;
export const LINKEDIN_NAME_LIMIT = 120;
export const LINKEDIN_TEXT_LIMIT = 20_000;
export const LINKEDIN_PATH_LIMIT = 512;

/** The elements a person can use, in the order the page holds them. */
const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="option"]',
  '[role="menuitem"]',
].join(', ');

/** Paths this plugin will navigate the LinkedIn tab to; anything else is refused, not escaped. */
const LINKEDIN_PATH_PREFIXES = ['/messaging/', '/feed/', '/in/', '/mynetwork/', '/jobs/', '/search/'];

/**
 * Shared in-page helpers: the one enumeration every expression re-runs, so an index means the same
 * thing whether it came from `inspect` or from `controlRect`.
 */
const pageBody = () => `
    const SELECTOR = ${JSON.stringify(CONTROL_SELECTOR)};
    const LIMIT = ${LINKEDIN_CONTROL_LIMIT};
    const NAME_LIMIT = ${LINKEDIN_NAME_LIMIT};
    const clean = value => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const attribute = (control, key) => (typeof control.getAttribute === 'function' ? control.getAttribute(key) : null);
    const nameOf = control => {
      const label = control.labels && control.labels[0];
      const candidates = [
        attribute(control, 'aria-label'),
        attribute(control, 'title'),
        control.innerText || control.textContent,
        attribute(control, 'placeholder'),
        label ? label.innerText || label.textContent : '',
      ];
      for (const candidate of candidates) {
        const name = clean(candidate);
        if (name) return name.slice(0, NAME_LIMIT);
      }
      return '';
    };
    const usable = control => {
      if (control.disabled === true) return false;
      if (attribute(control, 'aria-hidden') === 'true') return false;
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(control) : null;
      if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
      const rect = typeof control.getBoundingClientRect === 'function' ? control.getBoundingClientRect() : null;
      return !!rect && rect.width > 0 && rect.height > 0;
    };
    // querySelectorAll answers in document order and never twice for one element, and nothing here
    // sorts or filters by name: the index is the array position, so the same page yields the same
    // indexes on two consecutive runs.
    // Document order, nothing sorted: a modal is appended last, so the cap has to be generous
    // enough to reach it. Guessing at modal markup and scoping to it was worse — the page's own
    // controls are what a stale selector silently loses.
    const enumerate = () => {
      const controls = [];
      for (const control of document.querySelectorAll(SELECTOR)) {
        if (controls.length >= LIMIT) break;
        if (usable(control)) controls.push(control);
      }
      return controls;
    };
    const describe = (control, index) => {
      const rect = control.getBoundingClientRect();
      return {
        index,
        role: attribute(control, 'role') || String(control.tagName || '').toLowerCase(),
        name: nameOf(control),
        tag: String(control.tagName || '').toLowerCase(),
        x: Number(rect.x != null ? rect.x : rect.left) || 0,
        y: Number(rect.y != null ? rect.y : rect.top) || 0,
        width: Number(rect.width) || 0,
        height: Number(rect.height) || 0,
        focused: document.activeElement === control,
      };
    };
`;

/** Refuses a nonsensical index before any page work starts. */
function controlIndex(index: unknown, where: string): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new Error(`${where} needs a whole, non-negative control index; got ${String(index)}.`);
  }
  return index;
}

/** Every usable control on the page, in document order, as plain values. */
export function pageControlsExpression(): string {
  return `(() => {${pageBody()}
  return enumerate().map((control, index) => describe(control, index));
})()`;
}



/**
 * The control whose accessible name is `name` (and role is `role`, when given), as a live element
 * rather than a value, so the caller can hold a node handle to it. Indexes go stale here:
 * LinkedIn's messenger re-renders continuously, and a button resolved one call ago can be a
 * different button by the next call.
 */
export function findControlExpression(name: string, role?: string): string {
  const wanted = String(name ?? '').trim();
  if (!wanted || wanted.length > LINKEDIN_NAME_LIMIT) throw new Error('A LinkedIn lookup needs a control name of 1 to 120 characters.');
  const wantedRole = typeof role === 'string' && role.trim() ? role.trim().toLowerCase() : '';
  return `(() => {${pageBody()}
  const controls = enumerate();
  const wanted = ${JSON.stringify(wanted)}.toLowerCase();
  const wantedRole = ${JSON.stringify(wantedRole)};
  const roleOf = control => (attribute(control, 'role') || String(control.tagName || '').toLowerCase()).toLowerCase();
  const matches = control => !wantedRole || roleOf(control) === wantedRole;
  return controls.find(control => matches(control) && nameOf(control).toLowerCase() === wanted)
    || controls.find(control => matches(control) && nameOf(control).toLowerCase().includes(wanted))
    || null;
})()`;
}


/**
 * A structural description of the control at `index`: what it is, whether it or anything inside it
 * is editable, and whether a shadow root is hiding that. LinkedIn's composer swallowed three
 * insertion methods without a trace, and this is the read that says why.
 */
export function describeControlExpression(name: string, role?: string): string {
  if (typeof name !== 'string' || !name.trim() || name.length > LINKEDIN_NAME_LIMIT) throw new Error('A LinkedIn description needs a control name of 1 to 120 characters.');
  const wantedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return `(() => {${pageBody()}
  const controls = enumerate();
  const wanted = ${JSON.stringify(name.trim())}.toLowerCase();
  const wantedRole = ${JSON.stringify(wantedRole)};
  const roleOf = control => (attribute(control, 'role') || String(control.tagName || '').toLowerCase()).toLowerCase();
  const control = controls.find(candidate => (!wantedRole || roleOf(candidate) === wantedRole) && nameOf(candidate).toLowerCase().includes(wanted));
  if (!control) return { found: false, count: controls.length };
  const summary = node => node ? {
    tag: String(node.tagName || '').toLowerCase(),
    role: attribute(node, 'role') || '',
    contenteditable: attribute(node, 'contenteditable'),
    editable: node.isContentEditable === true,
    shadow: !!node.shadowRoot,
    hidden: (() => { const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null; return !!(style && (style.visibility === 'hidden' || style.display === 'none')); })(),
  } : null;
  const EDITS = '[contenteditable="true"], textarea, input';
  const inside = control.querySelector ? control.querySelector(EDITS) : null;
  return {
    found: true,
    self: summary(control),
    editableInside: summary(inside),
    children: control.children ? Array.from(control.children).slice(0, 4).map(summary) : [],
    shadowEditables: control.shadowRoot ? control.shadowRoot.querySelectorAll(EDITS).length : 0,
    text: String(control.innerText || control.textContent || '').slice(0, 200),
  };
})()`;
}


/** The page's visible text, so the caller can confirm what an action did. */
export function pageTextExpression(): string {
  return `(() => {
  const root = document.documentElement || document.body;
  const text = String((root && root.innerText) || '');
  return text.slice(0, ${LINKEDIN_TEXT_LIMIT});
})()`;
}

/**
 * A LinkedIn navigation path, or null. Anything else is refused rather than escaped: this value is
 * interpolated into a navigated URL, and a caller that does not hand a path on `www.linkedin.com`
 * has no business moving the tab.
 */
export function linkedInPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > LINKEDIN_PATH_LIMIT) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // A scheme, a control character, or an encoded traversal segment is never a path on this host.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  if (/%2e/i.test(value) || value.includes('..')) return null;
  return LINKEDIN_PATH_PREFIXES.some(prefix => value.startsWith(prefix)) ? value : null;
}

/**
 * The controls whose click leaves this machine's state and changes LinkedIn's: a send, an
 * invitation accepted or a connection made, a post published. This is the guard that makes the one
 * irreversible click explicit.
 */
/**
 * The only people a driver-initiated send may reach. This is the guard that exists because a name
 * search once offered "Robert Sinke" and the first suggestion was somebody else entirely: a send
 * must name its recipient, and the name has to be on this list. Empty list means no test send.
 */
export const LINKEDIN_SEND_ALLOWLIST: readonly string[] = ['andrea sophie stave lepsøe'];

/** The allowlist entry for `name`, matched exactly (case and spacing aside), or null. */
export function allowlistedRecipient(name: unknown): string | null {
  const wanted = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().toLowerCase() : '';
  if (!wanted) return null;
  return LINKEDIN_SEND_ALLOWLIST.find(entry => entry.toLowerCase() === wanted) ?? null;
}

/**
 * Who a compose box is addressed to right now, read from the recipient chips LinkedIn renders as
 * `Remove <name>` buttons. The caller compares this with the allowlist before it lets a send click
 * through: the chip is the only statement about the recipient that the page itself makes.
 */
export function recipientsExpression(): string {
  return `(() => {${pageBody()}
  const chips = [];
  for (const control of enumerate()) {
    const name = nameOf(control);
    const match = /^remove\\s+(.+)$/i.exec(name);
    if (match) chips.push(clean(match[1]));
  }
  return chips;
})()`;
}

/**
 * The conversation an open messaging page is showing, from the page's own URL — the one statement
 * about the target that an in-thread reply has. A reply box carries no recipient chips, so the urn
 * in `/messaging/thread/<urn>` is what a send approval must name.
 */
export function threadUrnExpression(): string {
  return `(() => {
  const thread = /^\\/messaging\\/thread\\/([^/?#]+)/.exec(location.pathname);
  if (!thread) return '';
  try { return decodeURIComponent(thread[1]); } catch (error) { return ''; }
})()`;
}

/** What a caller approved about a send: who may receive it, and — for a reply in an open thread — the conversation itself. */
export type SendApproval = { allow: 'send'; recipient?: string; conversation?: string };

/** The send policy's answer: either the click may go out, or the reason it may not. */
export type SendDecision = { ok: true; recipient: string } | { ok: false; reason: string };

/**
 * The whole send policy in one decision, so it can be tested without a page.
 *
 * The recipient must be allowlisted, and the page must agree about who is on the receiving end:
 * a compose box says it with recipient chips, an open thread says it with the conversation its own
 * URL names. `observed` carries whichever of those the page offered — the caller reads the chips
 * first and the thread urn only when there are no chips to read.
 */
export function sendApprovalDecision(approval: SendApproval | undefined, controlName: string, observed: { recipients: string[]; threadUrn: string }): SendDecision {
  const wanted = allowlistedRecipient(approval?.recipient);
  if (approval?.allow !== 'send' || !wanted) {
    return { ok: false, reason: `${JSON.stringify(controlName)} sends to LinkedIn; it needs { allow: 'send', recipient: '<allowlisted person>' }, and only allowlisted people can receive a test send.` };
  }
  if (observed.recipients.length > 0) {
    if (observed.recipients.length !== 1 || allowlistedRecipient(observed.recipients[0]) !== wanted) {
      return { ok: false, reason: `This send is addressed to ${observed.recipients.join(', ')}; only ${wanted} is allowlisted for a test send. Nothing was clicked.` };
    }
    return { ok: true, recipient: wanted };
  }
  if (!approval.conversation || !sameConversationUrn(observed.threadUrn, approval.conversation)) {
    return { ok: false, reason: `The page shows ${observed.threadUrn ? `conversation ${observed.threadUrn}` : 'no open conversation'}; the approval names ${approval.conversation ? `conversation ${approval.conversation}` : 'no conversation'}. Nothing was clicked.` };
  }
  return { ok: true, recipient: wanted };
}

// LinkedIn's own labels for the irreversible click: the modal's send button says "Compose message"
// while the button that *opens* the modal says "Compose a new message", and the anchors keep the
// two apart. Anything added here has to be a control that publishes or answers, never one that opens.
export const LINKEDIN_SEND_CONTROL = /^(send|send message|send now|compose message|send invitation|accept|connect|publish|post)$/i;

/** Matches that pattern against the control's trimmed, lowercased accessible name. */
export function isSendControl(control: PageControl): boolean {
  const name = typeof control?.name === 'string' ? control.name.trim().toLowerCase() : '';
  return name !== '' && LINKEDIN_SEND_CONTROL.test(name);
}
