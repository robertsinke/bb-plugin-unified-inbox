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
export const LINKEDIN_CONTROL_LIMIT = 200;
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
 * The control at `index` with its rect, or an error string naming how many controls the page has —
 * the rect is re-read from the live enumeration, so a click never lands on a stale one.
 */
export function controlRectExpression(index: number): string {
  const at = controlIndex(index, 'controlRectExpression');
  return `(() => {${pageBody()}
  const controls = enumerate();
  const control = controls[${at}];
  if (!control) return 'LinkedIn shows ' + controls.length + ' usable controls; index ${at} is out of range.';
  return describe(control, ${at});
})()`;
}

/** Focuses the control at `index`, so a following `Input.insertText` lands in that field. */
export function focusControlExpression(index: number): string {
  const at = controlIndex(index, 'focusControlExpression');
  return `(() => {${pageBody()}
  const controls = enumerate();
  const control = controls[${at}];
  if (!control) return { focused: false, reason: 'LinkedIn shows ' + controls.length + ' usable controls; index ${at} is out of range.' };
  try { control.focus(); } catch (error) { /* reported below */ }
  const name = nameOf(control);
  if (document.activeElement !== control) return { focused: false, reason: 'LinkedIn did not keep focus on ' + (name || 'that control') + '.' };
  return { focused: true, name };
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
export const LINKEDIN_SEND_CONTROL = /^(send|send message|send now|send invitation|accept|connect|publish|post)$/i;

/** Matches that pattern against the control's trimmed, lowercased accessible name. */
export function isSendControl(control: PageControl): boolean {
  const name = typeof control?.name === 'string' ? control.name.trim().toLowerCase() : '';
  return name !== '' && LINKEDIN_SEND_CONTROL.test(name);
}
