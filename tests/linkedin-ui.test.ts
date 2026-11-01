import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LINKEDIN_CONTROL_LIMIT,
  LINKEDIN_NAME_LIMIT,
  LINKEDIN_TEXT_LIMIT,
  isSendControl,
  linkedInPath,
  pageControlsExpression,
  pageTextExpression,
  type PageControl,
  findControlExpression,
  allowlistedRecipient,
  recipientsExpression,
  LINKEDIN_SEND_ALLOWLIST,
  describeControlExpression,
  sendApprovalDecision,
  threadKeyExpression,
  conversationKeyOf,
  type SendApproval,
} from '../src/linkedin-ui.ts';
import { writeRecorderExpression } from '../src/linkedin-write.ts';

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


test('a control is found by name, because an index goes stale between calls', async () => {
  const page = fakePage([
    { text: 'Compose a new message' },
    { text: 'Andrea Sophie Stave Lepsøe', role: 'option' },
    { text: 'Compose message' },
  ]);
  // The finder returns the element itself, so its identity is what matters, not its serialization.
  const matches = async (name: string, role?: string) => {
    const expression = findControlExpression(name, role);
    const run = new Function('document', 'getComputedStyle', `return (${expression});`);
    return await run(page.document, (element: any) => element.style);
  };
  assert.equal(await matches('Compose message'), page.elements[2]);
  assert.equal(await matches('andrea sophie', 'option'), page.elements[1]);
  assert.equal(await matches('Compose message', 'option'), null);
  assert.equal(await matches('nothing like this'), null);
  assert.throws(() => findControlExpression(''), /needs a control name/);
  assert.throws(() => findControlExpression('x'.repeat(200)), /needs a control name/);
});

test('only an allowlisted person can receive a test send, matched exactly', () => {
  assert.equal(allowlistedRecipient('Andrea Sophie Stave Lepsøe'), 'andrea sophie stave lepsøe');
  assert.equal(allowlistedRecipient('  andrea   sophie stave lepsøe '), 'andrea sophie stave lepsøe');
  // The failure this guard exists for: a lookalike name must never be accepted.
  for (const name of ['Robert Sinke', 'Andrea Sophie', 'Andrea Sophie Stave Lepsøe Jr', '', null, 42]) {
    assert.equal(allowlistedRecipient(name), null, `${String(name)} must not be allowlisted`);
  }
  assert.deepEqual(LINKEDIN_SEND_ALLOWLIST, ['andrea sophie stave lepsøe']);
});

test('the recipient chips are read from the page, because that is what the page says about the addressee', async () => {
  const page = fakePage([
    { text: 'Remove Robert Sinke', tag: 'button' },
    { text: 'Compose message', tag: 'button' },
  ]);
  assert.deepEqual(await page.evaluate(recipientsExpression()), ['Robert Sinke']);
  const empty = fakePage([{ text: 'Compose message', tag: 'button' }]);
  assert.deepEqual(await empty.evaluate(recipientsExpression()), []);
});

test('a pattern reaches the page with its backslash intact', () => {
  // `\s` written inside a template literal arrives as `s`, which once turned /^remove\s+(.+)$/
  // into /^removes+(.+)$/ and made every recipient chip invisible. The emitted source is asserted
  // because the behaviour alone looks like "no chips on screen".
  assert.ok(recipientsExpression().includes('^remove\\s+(.+)$'), 'the chip pattern lost its backslash on the way to the page');
  assert.ok(!recipientsExpression().includes('^removes+'));
});

test('the thread key is read from the page URL, because a reply box has no chips', () => {
  const expression = threadKeyExpression();
  // The regex escapes must survive the template literal, or the page reads every path as empty.
  assert.ok(expression.includes('/^\\/messaging\\/thread\\/([^/?#]+)/'), 'the thread pattern lost a backslash');
  const read = new Function('location', `return (${expression});`);
  const urn = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACo123,2-abc)';
  assert.equal(read({ pathname: `/messaging/thread/${encodeURIComponent(urn)}` }), urn);
  // The page URL carries the short key, and a full urn reads down to the same key.
  assert.equal(conversationKeyOf('urn:li:msg_conversation:(urn:li:fsd_profile:ACo123,2-abc==)'), '2-abc==');
  assert.equal(conversationKeyOf('2-abc=='), '2-abc==');
  assert.equal(conversationKeyOf('urn:li:msg_conversation:broken'), 'urn:li:msg_conversation:broken');
  assert.equal(conversationKeyOf(null), '');
  assert.equal(read({ pathname: "/messaging/thread/urn%3Abroken%'))" }), ''); // a bad encoding is nothing, not a guess
  assert.equal(read({ pathname: '/messaging/' }), '');
});

test('an in-thread send is allowed only when the approval names the conversation on screen', () => {
  const urn = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACo123,2-abc)';
  // A reply box has no chips, so the thread key decides: the page shows the short key the full
  // urn contains, and either form of the approval names the same conversation.
  const key = '2-ZDViYmEwOTQtNDlhNC00M2M0LTkyNTEtNjZlODQ0YTdmZDU4XzAxMg==';
  const full = `urn:li:msg_conversation:(urn:li:fsd_profile:ACo123,${key})`;
  const approval: SendApproval = { allow: 'send', recipient: 'Andrea Sophie Stave Lepsøe', conversation: full };
  assert.deepEqual(sendApprovalDecision(approval, 'Send', { recipients: [], threadKey: key }), { ok: true, recipient: 'andrea sophie stave lepsøe' });
  assert.equal(sendApprovalDecision({ ...approval, conversation: key }, 'Send', { recipients: [], threadKey: key }).ok, true);
  assert.equal(sendApprovalDecision({ ...approval, conversation: 'urn:li:msg_conversation:(urn:li:fsd_profile:somebody-else,2-x)' }, 'Send', { recipients: [], threadKey: key }).ok, false);
  assert.equal(sendApprovalDecision({ allow: 'send', recipient: 'Andrea Sophie Stave Lepsøe' }, 'Send', { recipients: [], threadKey: key }).ok, false);
  assert.equal(sendApprovalDecision({ ...approval }, 'Send', { recipients: [], threadKey: '' }).ok, false);
  // The compose box path is unchanged: the chips decide there, and the key is never consulted.
  assert.equal(sendApprovalDecision({ allow: 'send', recipient: 'Andrea Sophie Stave Lepsøe' }, 'Send', { recipients: ['Andrea Sophie Stave Lepsøe'], threadKey: '' }).ok, true);
  assert.equal(sendApprovalDecision({ ...approval }, 'Send', { recipients: ['Robert Sinke'], threadKey: key }).ok, false);
  // And the name gate still comes first, whichever box the send sits in.
  const refused = sendApprovalDecision(undefined, 'Send', { recipients: [], threadKey: key });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /needs \{ allow: 'send', recipient/);
});
