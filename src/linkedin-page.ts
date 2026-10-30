/**
 * In-page read of LinkedIn's own inbox, run inside the BB browser's signed-in session.
 *
 * The session never leaves the browser and nothing is clicked: no conversation is opened,
 * no invitation is accepted, and no message is sent. The requests are the same ones the
 * LinkedIn web app makes on load — messaging inbox, one conversation's messages, received
 * invitations, and display names.
 */
export type LinkedInRead = { mode: 'list' } | { mode: 'thread'; id: string };

const BODY = `
    const enc = u => encodeURIComponent(u).replace(/\\(/g, '%28').replace(/\\)/g, '%29');
    const pair = (document.cookie.split('; ').find(c => c.startsWith('JSESSIONID=')) || '').split('=')[1] || '';
    const headers = { 'csrf-token': decodeURIComponent(pair).replace(/^"|"$/g, ''), accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' };
    const get = async url => { const response = await fetch(url, { headers, credentials: 'include' }); if (!response.ok) throw new Error('LinkedIn ' + response.status + ' for ' + url.split('?')[0]); return JSON.parse(await response.text()); };
    const idOf = ref => String(ref || '').split(':').pop();

    const names = new Map();
    const avatars = new Map();
    const avatarOf = person => {
      const picture = person?.profilePicture || {};
      const display = picture['displayImage~'] || picture.displayImage || {};
      const identifiers = (display.elements || []).flatMap(element => element.identifiers || []).map(value => value.identifier).filter(value => typeof value === 'string');
      const direct = identifiers.find(value => value.startsWith('https://'));
      if (direct) return direct;
      const root = String(display.rootUrl || '');
      const path = (display.artifacts || []).map(value => value.fileIdentifyingUrlPathSegment).filter(value => typeof value === 'string').at(-1);
      return root && path ? root + path : '';
    };
    const linkedinImage = value => {
      try { const url = new URL(String(value)); return url.protocol === 'https:' && (url.hostname === 'licdn.com' || url.hostname.endsWith('.licdn.com')) ? url.href : ''; }
      catch { return ''; }
    };
    const nameOf = async id => {
      if (!id) return '';
      if (names.has(id)) return names.get(id);
      names.set(id, '');
      try {
        const profile = await get('/voyager/api/identity/dash/profiles/' + enc('urn:li:fsd_profile:' + id));
        const person = (profile.included || []).find(e => e && e.firstName) || profile.data || {};
        names.set(id, [person.firstName, person.lastName].filter(Boolean).join(' '));
        avatars.set(id, linkedinImage(avatarOf(person)));
      } catch { /* a name is presentation detail; the row still carries its id and message */ }
      return names.get(id);
    };

    const me = await get('/voyager/api/me');
    // This reference survives when LinkedIn omits the inlined MiniProfile, so read it first.
    const meRef = String(me.data?.['*miniProfile'] || (me.included || []).find(e => /miniProfile/.test(String(e.$type || '')))?.entityUrn || '');
    if (!/^urn:li:fs_miniProfile:/.test(meRef)) throw new Error('LinkedIn session is not signed in');
    const meId = meRef.split(':').pop();

    if (request.mode === 'thread') {
      const json = await get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314&variables=(conversationUrn:' + enc(request.id) + ')');
      const events = (json.included || []).filter(e => /linkedin\\.messenger\\.Message$/.test(String(e.$type || '')));
      const actorIds = [...new Set(events.map(e => idOf(e['*sender'] || e['*actor'])))].filter(id => id && id !== meId);
      await Promise.all(actorIds.map(nameOf));
      return { messages: events.map(e => {
        const actor = idOf(e['*sender'] || e['*actor']);
        return { sender: actor === meId ? 'You' : names.get(actor) || 'LinkedIn', text: String(e.body?.text || e.renderContentFallbackText || ''), date: Number(e.deliveredAt || 0), fromMe: actor === meId };
      }) };
    }

    const inbox = await get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.0d5e6781bbee71c3e51c8843c6519f48&variables=(mailboxUrn:' + enc(meRef.replace('fs_miniProfile', 'fsd_profile')) + ')');
    const entities = (inbox.included || []).filter(e => /msg_conversation/.test(String(e.entityUrn || '')));
    const counterpartIds = [...new Set(entities.flatMap(e => (e['*conversationParticipants'] || []).map(idOf)).filter(id => id && id !== meId))];
    await Promise.all(counterpartIds.map(nameOf));
    const conversations = entities.map(e => {
      const others = (e['*conversationParticipants'] || []).map(idOf).filter(id => id && id !== meId);
      const avatarUrl = others.length === 1 ? avatars.get(others[0]) : '';
      return { id: String(e.entityUrn), title: String(e.title || '') || others.map(id => names.get(id)).filter(Boolean).join(', '), preview: String(e.descriptionText || ''), date: Number(e.lastActivityAt || 0), unread: Number(e.unreadCount || 0) > 0, ...(avatarUrl ? { avatarUrl } : {}) };
    });

    const invites = await get('/voyager/api/relationships/invitationViews?q=receivedInvitation&start=0&count=20');
    const invitePeople = new Map((invites.included || []).filter(e => e?.entityUrn).map(e => [e.entityUrn, e]));
    const inviteRows = (invites.included || []).filter(e => /relationships\\.invitation\\.Invitation$/.test(String(e.$type || '')));
    await Promise.all(inviteRows.filter(e => !invitePeople.has(String(e['*fromMember'] || ''))).map(e => nameOf(idOf(e['*fromMember']))));
    const invitations = inviteRows.map(e => {
      const ref = String(e['*fromMember'] || '');
      const person = invitePeople.get(ref) || {};
      const title = [person.firstName, person.lastName].filter(Boolean).join(' ') || names.get(idOf(ref)) || '';
      // customMessage only says whether a note exists; the note itself is the message field.
      const note = String(typeof e.message === 'string' ? e.message : '').trim();
      const avatarUrl = linkedinImage(avatarOf(person)) || avatars.get(idOf(ref)) || '';
      return { id: String(e.entityUrn || e.mailboxItemId || ''), title, preview: note, date: Number(e.sentTime || 0), unread: e.unseen === true, sender: title, ...(avatarUrl ? { avatarUrl } : {}) };
    });

    return { conversations, invitations };
`;

/** The script the BB browser runs on a LinkedIn page; it prints one JSON payload. */
export function linkedinPageScript(read: LinkedInRead): string {
  // The script reports its own failure as JSON so the bridge can name the reason instead of
  // parsing a CLI error, and so a signed-out session never reads as an empty inbox.
  return `const request = ${JSON.stringify(read)};
try {
  const payload = await page.evaluate(async (request) => {${BODY}}, request);
  console.log(JSON.stringify({ ok: true, payload }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String((error && error.message) || error).split(String.fromCharCode(10))[0] }));
}`;
}

/** Reads the payload out of `bb browser-automation run --json` output. */
export function linkedinRunOutput(stdout: string): unknown {
  let run: { text?: unknown; exitCode?: unknown; ok?: unknown; payload?: unknown; error?: unknown };
  try { run = JSON.parse(stdout) as typeof run; } catch { throw new Error('LinkedIn did not answer from the browser.'); }
  // The CLI can emit the script's JSON directly on success, but wraps script output in
  // {text, exitCode} when reporting a runtime failure. Accept both shapes.
  if (typeof run.ok === 'boolean') return run;
  if (run.exitCode !== 0 || typeof run.text !== 'string') throw new Error('LinkedIn did not answer from the browser.');
  const payload = run.text.trim();
  if (!payload.startsWith('{')) throw new Error('LinkedIn did not answer from the browser.');
  return JSON.parse(payload);
}
