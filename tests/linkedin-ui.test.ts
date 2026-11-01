import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LINKEDIN_CONTROL_LIMIT,
  LINKEDIN_NAME_LIMIT,
  LINKEDIN_TEXT_LIMIT,
  controlRectExpression,
  focusControlExpression,
  isSendControl,
  linkedInPath,
  pageControlsExpression,
  pageTextExpression,
  type PageControl,
  controlTextExpression,
  typingTargetExpression,
} from '../src/linkedin-ui.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

/** The browser globals the expressions may touch, and nothing else. */
type ControlSpec = {
  tag?: string;
  role?: string;
  ariaLabel?: string;
  title?: string;
  text?: string;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  ariaHidden?: boolean;
  display?: string;
  visibility?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

/**
 * A fake page: the elements in document order, their computed style, and the document the
 * expressions read. It answers `querySelectorAll` with the same list every time, the way a real
 * document answers the same selector twice when nothing has changed.
 */
function fakePage(specs: ControlSpec[], pageText = '') {
  const elements: any[] = specs.map(spec => {
    const element: any = {
      tagName: String(spec.tag ?? 'button').toUpperCase(),
      innerText: spec.text ?? '',
      disabled: spec.disabled === true,
      labels: spec.label === undefined ? [] : [{ innerText: spec.label }],
      style: { display: spec.display ?? 'block', visibility: spec.visibility ?? 'visible' },
      getAttribute(key: string) {
        if (key === 'aria-label') return spec.ariaLabel ?? null;
        if (key === 'title') return spec.title ?? null;
        if (key === 'placeholder') return spec.placeholder ?? null;
        if (key === 'role') return spec.role ?? null;
        if (key === 'aria-hidden') return spec.ariaHidden ? 'true' : null;
        return null;
      },
      getBoundingClientRect() {
        return { x: spec.x ?? 10, y: spec.y ?? 20, width: spec.width ?? 100, height: spec.height ?? 30 };
      },
      focus() { document.activeElement = element; },
    };
    return element;
  });
  const document: any = {
    activeElement: null,
    documentElement: { innerText: pageText },
    // The dialog probe answers separately, so a test can put a modal in front of a crowded page.
    querySelectorAll: () => elements,
  };
  const getComputedStyle = (element: any) => element.style;
  const evaluate = async (expression: string) => {
    const run = new AsyncFunction('document', 'getComputedStyle', `return (${expression});`);
    return await run(document, getComputedStyle);
  };
  return { document, elements, evaluate };
}

test('indexes are array positions, and two runs over the same page agree', async () => {
  const page = fakePage([
    { text: 'Search' },
    { tag: 'a', text: 'Messages' },
    { tag: 'textarea', placeholder: 'Write a message…' },
    { tag: 'div', role: 'menuitem', text: 'Mark as read' },
  ]);
  const first = await page.evaluate(pageControlsExpression()) as PageControl[];
  const second = await page.evaluate(pageControlsExpression()) as PageControl[];

  assert.deepEqual(first.map(control => control.index), [0, 1, 2, 3]);
  assert.deepEqual(first.map(control => control.name), ['Search', 'Messages', 'Write a message…', 'Mark as read']);
  assert.deepEqual(first.map(control => control.tag), ['button', 'a', 'textarea', 'div']);
  assert.deepEqual(first.map(control => control.role), ['button', 'a', 'textarea', 'menuitem']);
  assert.deepEqual(second, first);
  assert.deepEqual(first[1], { index: 1, role: 'a', name: 'Messages', tag: 'a', x: 10, y: 20, width: 100, height: 30, focused: false });
});

test('the enumeration asks for the element kinds a person can use, all at once', () => {
  const expression = pageControlsExpression();
  assert.doesNotThrow(() => new AsyncFunction('document', 'getComputedStyle', `return (${expression});`));
  // The selector travels as a JSON string, so its quotes are escaped in the expression text.
  const selector = expression.replace(/\\"/g, '"');
  for (const kind of ['button', 'a[href]', 'input', 'textarea', 'select', '[contenteditable="true"]', '[role="button"]', '[role="menuitem"]']) {
    assert.ok(selector.includes(kind), `the selector should carry ${kind}`);
  }
  // No envelope: these expressions answer plain values, unlike the read module.
  // The modal's send button says "Compose message"; the one that opens the modal is different.
  assert.equal(isSendControl({ index: 0, role: 'button', name: 'Compose message', tag: 'button', x: 0, y: 0, width: 1, height: 1, focused: false }), true);
  assert.equal(isSendControl({ index: 0, role: 'button', name: 'Compose a new message', tag: 'button', x: 0, y: 0, width: 1, height: 1, focused: false }), false);
  assert.doesNotMatch(expression, /ok: true/);
});

test('hidden, aria-hidden, disabled, and zero-size controls are excluded', async () => {
  const page = fakePage([
    { text: 'Visible' },
    { text: 'Display none', display: 'none' },
    { text: 'Visibility hidden', visibility: 'hidden' },
    { text: 'Disabled', disabled: true },
    { text: 'Aria hidden', ariaHidden: true },
    { text: 'Zero width', width: 0 },
    { text: 'Zero height', height: 0 },
  ]);
  const controls = await page.evaluate(pageControlsExpression()) as PageControl[];
  assert.deepEqual(controls.map(control => control.name), ['Visible']);
  assert.equal(controls[0].index, 0);
});

test('the list is capped, and the cap counts usable controls rather than elements', async () => {
  const page = fakePage([
    ...Array.from({ length: LINKEDIN_CONTROL_LIMIT + 50 }, (_, index) => ({ text: `Control ${index}` })),
  ]);
  const controls = await page.evaluate(pageControlsExpression()) as PageControl[];
  assert.equal(controls.length, LINKEDIN_CONTROL_LIMIT);
  assert.equal(controls.at(-1)?.index, LINKEDIN_CONTROL_LIMIT - 1);
  assert.equal(controls.at(-1)?.name, `Control ${LINKEDIN_CONTROL_LIMIT - 1}`);
});

test('a name falls back through aria-label, title, text, placeholder, and label, trimmed and capped', async () => {
  const page = fakePage([
    { ariaLabel: ' aria name ', title: 'title', text: 'text', placeholder: 'placeholder', label: 'label' },
    { title: ' title ', text: 'text', placeholder: 'placeholder', label: 'label' },
    { text: '  spaced \n out  ', placeholder: 'placeholder', label: 'label' },
    { tag: 'input', placeholder: ' placeholder ', label: 'label' },
    { tag: 'input', label: ' label text ' },
    { tag: 'input' },
    { text: 'x'.repeat(LINKEDIN_NAME_LIMIT + 80) },
  ]);
  const controls = await page.evaluate(pageControlsExpression()) as PageControl[];
  assert.deepEqual(controls.map(control => control.name), [
    'aria name',
    'title',
    'spaced out',
    'placeholder',
    'label text',
    '',
    'x'.repeat(LINKEDIN_NAME_LIMIT),
  ]);
});

test('the focused control says so, so a caller can see where input will land', async () => {
  const page = fakePage([{ text: 'Search' }, { tag: 'textarea', placeholder: 'Write a message…' }]);
  const focused = await page.evaluate(focusControlExpression(1)) as { focused: boolean; name?: string };
  assert.deepEqual(focused, { focused: true, name: 'Write a message…' });
  assert.equal(page.document.activeElement, page.elements[1]);
  const controls = await page.evaluate(pageControlsExpression()) as PageControl[];
  assert.deepEqual(controls.map(control => control.focused), [false, true]);
});

test('a control rect re-reads the live page and names the count when the index is gone', async () => {
  const page = fakePage([{ text: 'Search', x: 40, y: 50, width: 20, height: 10 }, { text: 'Send' }]);
  const found = await page.evaluate(controlRectExpression(0)) as PageControl;
  assert.equal(found.name, 'Search');
  assert.deepEqual({ x: found.x, y: found.y, width: found.width, height: found.height }, { x: 40, y: 50, width: 20, height: 10 });

  const missing = await page.evaluate(controlRectExpression(5));
  assert.equal(missing, 'LinkedIn shows 2 usable controls; index 5 is out of range.');

  const unfocusable = await page.evaluate(focusControlExpression(5)) as { focused: boolean; reason: string };
  assert.equal(unfocusable.focused, false);
  assert.match(unfocusable.reason, /2 usable controls; index 5 is out of range/);
});

test('a control index that is negative or fractional is refused before any page work', () => {
  for (const hostile of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => controlRectExpression(hostile), /whole, non-negative control index/);
    assert.throws(() => focusControlExpression(hostile), /whole, non-negative control index/);
  }
  // @ts-expect-error a string index from an untyped RPC is refused too.
  assert.throws(() => controlRectExpression('0'), /whole, non-negative control index/);
});

test('the page text is capped, so a long page cannot travel whole', async () => {
  const long = 'x'.repeat(LINKEDIN_TEXT_LIMIT + 5_000);
  const page = fakePage([], long);
  const text = await page.evaluate(pageTextExpression()) as string;
  assert.equal(text.length, LINKEDIN_TEXT_LIMIT);
  assert.equal(text, long.slice(0, LINKEDIN_TEXT_LIMIT));

  const short = fakePage([], 'Inbox · 3 new messages');
  assert.equal(await short.evaluate(pageTextExpression()), 'Inbox · 3 new messages');
});

test('only LinkedIn paths are navigable, and a scheme, host, or traversal is refused', () => {
  for (const accepted of ['/messaging/', '/in/someone/', '/feed/update/urn:li:activity:1/', '/mynetwork/invitation-manager/', '/jobs/search/?keywords=design', '/search/results/all/']) {
    assert.equal(linkedInPath(accepted), accepted);
  }
  const refused = [
    'https://evil.test/messaging/',
    '//evil.test/',
    '/messaging/../../evil',
    'javascript:x',
    '/%2e%2e/feed/',
    '/messaging\\..\\..\\feed',
    'www.linkedin.com/messaging/',
    '/not-messaging/',
    '/' + 'a'.repeat(600),
    '',
    null,
    42,
  ];
  for (const value of refused) {
    assert.equal(linkedInPath(value), null, `should refuse ${String(value).slice(0, 40)}`);
  }
});

test('the send guard matches the controls that change LinkedIn state and nothing else', () => {
  const control = (name: string): PageControl => ({ index: 0, role: 'button', name, tag: 'button', x: 0, y: 0, width: 1, height: 1, focused: false });
  // "Compose message" is the modal's send button on today's markup; "Compose a new message" opens it.
  for (const name of ['Send', 'Send message', ' send now ', 'Compose message', 'Send invitation', 'Accept', 'Connect', 'Publish', 'Post']) {
    assert.equal(isSendControl(control(name)), true, `${name} should need approval`);
  }
  for (const name of ['Search', 'See all', 'Compose a new message', 'Dismiss', '', 'Send later']) {
    assert.equal(isSendControl(control(name)), false, `${name} should not need approval`);
  }
});

test('the cap is generous enough to reach a modal appended after a crowded page', async () => {
  // A compose modal is the last thing in the document; a tight cap truncated it away entirely.
  const page = fakePage(Array.from({ length: 450 }, () => ({ text: 'Page control' })));
  const controls = await page.evaluate(pageControlsExpression());
  assert.equal(controls.length, 450);
});

test('a crowded page stops at the cap rather than returning everything', async () => {
  const page = fakePage(Array.from({ length: LINKEDIN_CONTROL_LIMIT + 40 }, () => ({ text: 'Page control' })));
  const controls = await page.evaluate(pageControlsExpression());
  assert.equal(controls.length, LINKEDIN_CONTROL_LIMIT);
});

test('a field can be read back, so a caller sees whether typing landed', async () => {
  const page = fakePage([{ tag: 'div', text: '' }]);
  const element = page.elements[0];
  assert.equal(await page.evaluate(controlTextExpression(0)), '');
  element.innerText = 'Note to self';
  assert.equal(await page.evaluate(controlTextExpression(0)), 'Note to self');
  assert.equal(await page.evaluate(controlTextExpression(9)), '');
});

test('typing targets the editable inside a wrapper, because a role=textbox div takes focus and nothing else', async () => {
  const inner = { tagName: 'DIV', isContentEditable: true, innerText: '', getAttribute: () => null, getBoundingClientRect: () => ({ x: 5, y: 6, width: 200, height: 40 }), querySelector: () => null, style: {} };
  const page = fakePage([{ tag: 'div', role: 'textbox', text: 'Write a message…' }]);
  const wrapper = page.elements[0];
  wrapper.isContentEditable = false;
  wrapper.querySelector = (selector: string) => (/contenteditable/.test(selector) ? inner : null);
  const target = await page.evaluate(typingTargetExpression(0));
  assert.equal(target.editable, true);
  assert.deepEqual([target.x, target.y, target.width, target.height], [5, 6, 200, 40]);

  // A wrapper with nothing editable inside says so instead of pretending to type.
  wrapper.querySelector = () => null;
  assert.deepEqual(await page.evaluate(typingTargetExpression(0)), { editable: false, name: 'Write a message…' });
});
