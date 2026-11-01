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
 * The short conversation key a LinkedIn thread URL names — the `2-…` that sits inside a full
 * conversation urn's parentheses. A thread URL carries the key alone; a cached row carries the full
 * urn; a send approval may arrive as either, so both are read down to the key before they are
 * compared. Anything this does not recognise is passed through unchanged, so an unrecognised
 * value can only fail the comparison, never pass it by transformation.
 */
export function conversationKeyOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const full = /^urn:li:msg_conversation:\((urn:li:fsd_profile:[^,]+),(.+)\)$/.exec(value);
  return full ? full[2] : value;
}

/**
 * The conversation an open messaging page is showing, from the page's own URL — the one statement
 * about the target that an in-thread reply has. A reply box carries no recipient chips, so the key
 * in `/messaging/thread/<key>` is what a send approval must name.
 */
export function threadKeyExpression(): string {
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

/** Two names that differ only in case and spacing name the same person. */
export function samePersonName(left: unknown, right: unknown): boolean {
  const shape = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
  const a = shape(left);
  return !!a && a === shape(right);
}

/**
 * The whole send policy in one decision, so it can be tested without a page.
 *
 * A send click needs `{ allow: 'send' }` plus a target the page itself confirms: a compose box
 * says it with recipient chips, an open thread says it with the conversation its own URL names.
 * The approval names who or which, and a page that disagrees refuses the click — a name search
 * once offered somebody else entirely, and the target must never be an assumption. `observed`
 * carries whichever of those the page offered — the caller reads the chips first and the thread
 * key only when there are no chips to read.
 */
export function sendApprovalDecision(approval: SendApproval | undefined, controlName: string, observed: { recipients: string[]; threadKey: string }): SendDecision {
  if (approval?.allow !== 'send') {
    return { ok: false, reason: `${JSON.stringify(controlName)} sends to LinkedIn; it needs { allow: 'send' } plus the target it is approved for: the compose box's recipient, or the conversation an open thread is showing.` };
  }
  if (observed.recipients.length > 0) {
    if (observed.recipients.length !== 1 || !samePersonName(observed.recipients[0], approval.recipient)) {
      return { ok: false, reason: `This send is addressed to ${observed.recipients.join(', ') || 'nobody'}; the approval names ${approval.recipient ?? 'nobody'}. Nothing was clicked.` };
    }
    return { ok: true, recipient: observed.recipients[0] };
  }
  const shown = conversationKeyOf(observed.threadKey);
  const approved = conversationKeyOf(approval.conversation ?? '');
  if (!approved || shown !== approved) {
    return { ok: false, reason: `The page shows ${shown ? `conversation ${shown}` : 'no open conversation'}; the approval names ${approved ? `conversation ${approved}` : 'no conversation'}. Nothing was clicked.` };
  }
  return { ok: true, recipient: approved };
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
