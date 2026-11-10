import { CONVERSATION_URN_SOURCE } from './linkedin-conversation.ts';

/**
 * In-page read of LinkedIn's own inbox, run inside the BB browser's signed-in session.
 *
 * The session never leaves the browser and nothing is clicked: no conversation is opened,
 * no invitation is accepted, and no message is sent. The requests are the same ones the
 * LinkedIn web app makes on load — messaging inbox, one conversation's messages, received
 * invitations, and display names — plus, for `older`, the paged read the app sends when its
 * conversation list is scrolled.
 */
export type LinkedInRead =
  | { mode: 'list' }
  | { mode: 'thread'; id: string }
  | { mode: 'probe'; mailbox?: string }
  | { mode: 'older'; cursor: string; count: number };

/**
 * The query the web app pages its conversation list with, pinned the way the inbox read is.
 *
 * It is a *second* query, not a paging variable on the by-sync-token read above: that one
 * silently ignores `start`, `count`, `offset`, `cursor` and every other name tried against it and
 * always answers the newest 20 (see docs/research/linkedin/messenger-conversations-paging.md).
 */
export const LINKEDIN_OLDER_QUERY = 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf';

/**
 * The most conversations one older page may ask for. Measured: 22 and 25 answered, 29 and 30
 * answered an empty collection with status 200 — a count LinkedIn refuses without saying so.
 */
export const LINKEDIN_OLDER_PAGE_MAX = 25;

/**
 * The cursor for a walk nobody has started yet. The first press reads the first primary page.
 * The panel drops rows the sync-token page already shows. Only the server's own `nextCursor`
 * moves the window after that — `lastUpdatedBefore` and every other name tried against the query
 * is ignored.
 */
export const LINKEDIN_WALK_START = 'start';

/**
 * A cursor safe to inject, or a refusal. `enc()` would quote anything, so this is a bound on
 * nonsense rather than an escape: the server's cursors are base64, and the seed the adapter
 * derives from the newest page is the timestamp that page's oldest row carried.
 */
export function linkedinOlderCursor(value: unknown): string {
  if (typeof value === 'string' && /^[A-Za-z0-9+/=]{1,512}$/.test(value)) return value;
  throw new Error('That is not a page of LinkedIn conversations this plugin can fetch.');
}

/**
 * A conversation's preview is its newest message body. LinkedIn messages without text carry the
 * content in `renderContent` instead, so these labels name the shapes seen in the payload.
 */
export const LINKEDIN_PREVIEW_LABELS: Record<string, string> = {
  feed_update: 'Shared a post',
  file: 'File',
  vectorImage: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  repliedMessageContent: 'Replied to a message',
  forwardedMessageContent: 'Forwarded a message',
};

const BODY = `
    const enc = u => encodeURIComponent(u).replace(/\\(/g, '%28').replace(/\\)/g, '%29');
    const pair = (document.cookie.split('; ').find(c => c.startsWith('JSESSIONID=')) || '').split('=')[1] || '';
    const headers = { 'csrf-token': decodeURIComponent(pair).replace(/^"|"$/g, ''), accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' };
    const get = async url => { const response = await fetch(url, { headers, credentials: 'include' }); if (!response.ok) throw new Error('LinkedIn ' + response.status + ' for ' + url.split('?')[0]); return JSON.parse(await response.text()); };

    // What a conversation is, from the one rule: the shared pattern. A message urn wraps a
    // conversation urn, so a substring test would list messages as conversations, which is exactly
    // what it used to do.
    const conversationUrn = new RegExp(${JSON.stringify(CONVERSATION_URN_SOURCE)});

    const names = new Map();
    const avatars = new Map();
    const avatarOf = person => {
      const picture = person?.profilePicture || person?.picture || person || {};
      // Shapes differ: a profile nests displayImage.vectorImage, a company logo wraps { image }, older payloads hand the vector image itself.
      const image = picture.image || picture['displayImage~'] || picture.displayImage || picture;
      const display = image.vectorImage || image;
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
    // A message without text carries its content here, and every payload returns all of these keys: only a set one is content.
    const contentOf = item => {
      const content = Array.isArray(item?.renderContent) ? item.renderContent[0] : item?.renderContent;
      return content && typeof content === 'object' ? content : null;
    };
    // A photo's largest element is the image the inbox shows; anything not on LinkedIn's CDN is not an image.
    const photoOf = item => {
      const content = contentOf(item);
      return content && content.vectorImage ? linkedinImage(avatarOf(content.vectorImage)) : '';
    };
    // A shared post has no thumbnail in the payload, only the update it points at.
    const activityOf = item => {
      const host = contentOf(item)?.hostUrnData;
      if (!host || host.type !== 'FEED_UPDATE') return '';
      const match = /urn:li:activity:\\d+/.exec(String(host.hostUrn || ''));
      return match ? match[0] : '';
    };
    // A participant is a member profile or a company page, and only the urn says which.
    const identityKey = ref => {
      const match = /urn:li:fsd_(profile|company):([^,)]+)/.exec(String(ref || ''));
      return match ? 'fsd_' + match[1] + ':' + match[2] : '';
    };
    const nameOf = async ref => {
      const key = identityKey(ref);
      if (!key) return '';
      if (names.has(key)) return names.get(key);
      names.set(key, '');
      try {
        if (key.startsWith('fsd_company:')) {
          const company = await get('/voyager/api/organization/companies/' + enc(key.slice('fsd_company:'.length)));
          const organization = company?.data || company || {};
          names.set(key, String(organization.localizedName || organization.name || ''));
          avatars.set(key, linkedinImage(avatarOf({ profilePicture: organization.logo })));
        } else {
          const profile = await get('/voyager/api/identity/dash/profiles/' + enc('urn:li:' + key));
          const person = (profile.included || []).find(e => e && e.firstName) || profile.data || {};
          names.set(key, [person.firstName, person.lastName].filter(Boolean).join(' '));
          avatars.set(key, linkedinImage(avatarOf(person)));
        }
      } catch { /* a name is presentation detail; the row still carries its id and message */ }
      return names.get(key);
    };

    const me = await get('/voyager/api/me');
    // This reference survives when LinkedIn omits the inlined MiniProfile, so read it first.
    const meRef = String(me.data?.['*miniProfile'] || (me.included || []).find(e => /miniProfile/.test(String(e.$type || '')))?.entityUrn || '');
    if (!/^urn:li:fs_miniProfile:/.test(meRef)) throw new Error('LinkedIn session is not signed in');
    const meKey = identityKey(meRef.replace('fs_miniProfile', 'fsd_profile'));

    if (request.mode === 'thread') {
      const json = await get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314&variables=(conversationUrn:' + enc(request.id) + ')');
      const events = (json.included || []).filter(e => /linkedin\\.messenger\\.Message$/.test(String(e.$type || '')));
      const actors = [...new Set(events.map(e => String(e['*sender'] || e['*actor'] || '')))].filter(ref => { const key = identityKey(ref); return key && key !== meKey; });
      await Promise.all(actors.map(nameOf));
      return { messages: events.map(e => {
        const key = identityKey(e['*sender'] || e['*actor']);
        const mine = key === meKey;
        // The message urn is what a later media request names, so the picture travels with it.
        return { id: String(e.entityUrn || ''), sender: mine ? 'You' : names.get(key) || 'LinkedIn', senderUrn: key ? 'urn:li:' + key : '', text: String(e.body?.text || e.renderContentFallbackText || ''), date: Number(e.deliveredAt || 0), fromMe: mine, mediaUrl: photoOf(e), activityUrn: activityOf(e) };
      }) };
    }

    // The payload inlines each conversation's latest messages, so a body can stand in for the empty descriptionText.
    const previewLabels = ${JSON.stringify(LINKEDIN_PREVIEW_LABELS)};
    const previewOf = item => {
      const text = String(item.body?.text || item.renderContentFallbackText || '').trim();
      if (text) return text;
      const content = contentOf(item);
      if (!content) return '';
      if (content.hostUrnData && content.hostUrnData.type === 'FEED_UPDATE') return previewLabels.feed_update;
      for (const key of ['file', 'vectorImage', 'video', 'audio', 'repliedMessageContent', 'forwardedMessageContent']) {
        if (content[key]) return previewLabels[key] || '';
      }
      return '';
    };
    const previewsOf = included => {
      const previews = new Map();
      for (const item of included || []) {
        if (!/linkedin\.messenger\.Message$/.test(String(item.$type || ''))) continue;
        const key = String(item['*conversation'] || '');
        const body = previewOf(item);
        if (!key || !body) continue;
        const at = Number(item.deliveredAt || 0);
        const mine = identityKey(item['*sender'] || item['*actor']) === meKey;
        const seen = previews.get(key);
        if (!seen || at >= seen.at) previews.set(key, { at, body, mine });
      }
      return previews;
    };
    // One row shape for both reads, so a walked-back conversation is drawn like the newest page.
    const rowsOf = async (entities, previews) => {
      const counterparts = [...new Set(entities.flatMap(e => e['*conversationParticipants'] || []).filter(ref => { const key = identityKey(ref); return key && key !== meKey; }))];
      await Promise.all(counterparts.map(nameOf));
      return entities.map(e => {
        const others = (e['*conversationParticipants'] || []).filter(ref => { const key = identityKey(ref); return key && key !== meKey; });
        const people = others.map(ref => names.get(identityKey(ref))).filter(Boolean).join(', ');
        const avatarUrl = others.length === 1 ? avatars.get(identityKey(others[0])) : '';
        const latest = previews.get(String(e.entityUrn));
        const described = String(e.descriptionText || '').trim();
        const preview = described || latest?.body || '';
        // The list names the other person even when the newest line is yours. The flag is the speaker.
        const ownPreview = latest?.mine === true && preview !== '' && (!described || described === latest.body || latest.body.startsWith(described) || described.startsWith(latest.body));
        return { id: String(e.entityUrn), title: String(e.title || '') || people, preview, date: Number(e.lastActivityAt || 0), unread: Number(e.unreadCount || 0) > 0, sender: people, ...(avatarUrl ? { avatarUrl } : {}), ...(ownPreview ? { fromMe: true } : {}) };
      });
    };

    if (request.mode === 'older') {
      // The paged read the web app sends when its conversation list is scrolled: a cursor-paged
      // collection, not the by-sync-token read above. Only the server's own cursor moves the window.
      // The seed cursor has no server cursor yet, so this read is the first primary page. That page
      // is not the sync-token window: archived InMail in that window pushes primary conversations
      // onto this one, and dropping it here would skip them. The panel removes rows it already shows.
      const mailbox = enc(meRef.replace('fs_miniProfile', 'fsd_profile'));
      const pageOf = async tail => {
        const url = '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${LINKEDIN_OLDER_QUERY}&variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:' + request.count + ',mailboxUrn:' + mailbox + (tail ? ',' + tail : '') + ')';
        const json = await get(url);
        return { node: json?.data?.data?.messengerConversationsByCategoryQuery || {}, included: json?.included || [] };
      };
      const beginning = request.cursor === ${JSON.stringify(LINKEDIN_WALK_START)};
      const page = await pageOf(beginning ? '' : 'nextCursor:' + enc(request.cursor));
      // The page names its rows in order, so the cursor it hands back belongs to the last of them.
      const inlined = new Map(page.included.filter(e => conversationUrn.test(String(e.entityUrn || ''))).map(e => [String(e.entityUrn), e]));
      const entities = (page.node['*elements'] || []).map(urn => inlined.get(String(urn))).filter(Boolean);
      return { conversations: await rowsOf(entities, previewsOf(page.included)), nextCursor: String(page.node.metadata?.nextCursor || '') };
    }

    const inbox = await get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.0d5e6781bbee71c3e51c8843c6519f48&variables=(mailboxUrn:' + enc(meRef.replace('fs_miniProfile', 'fsd_profile')) + ')');
    const entities = (inbox.included || []).filter(e => conversationUrn.test(String(e.entityUrn || '')));
    const conversations = await rowsOf(entities, previewsOf(inbox.included));

    const invites = await get('/voyager/api/relationships/invitationViews?q=receivedInvitation&start=0&count=20');
    const invitePeople = new Map((invites.included || []).filter(e => e?.entityUrn).map(e => [e.entityUrn, e]));
    const inviteRows = (invites.included || []).filter(e => /relationships\\.invitation\\.Invitation$/.test(String(e.$type || '')));
    await Promise.all(inviteRows.filter(e => !invitePeople.has(String(e['*fromMember'] || ''))).map(e => nameOf(e['*fromMember'])));
    const invitations = inviteRows.map(e => {
      const ref = String(e['*fromMember'] || '');
      const person = invitePeople.get(ref) || {};
      const title = [person.firstName, person.lastName].filter(Boolean).join(' ') || names.get(identityKey(ref)) || '';
      // customMessage only says whether a note exists; the note itself is the message field.
      const note = String(typeof e.message === 'string' ? e.message : '').trim();
      const avatarUrl = linkedinImage(avatarOf(person)) || avatars.get(identityKey(ref)) || '';
      // The invitation answer needs what the payload itself carries: the sharedSecret the page's
      // own accept click sends as its validationToken, and the inviter's profile id. Without these
      // a row could be shown but not answered.
      const profileOf = /^urn:li:fsd_profile:(.+)$/.exec(ref);
      return { id: String(e.entityUrn || e.mailboxItemId || ''), title, preview: note, date: Number(e.sentTime || 0), unread: e.unseen === true, sender: title, ...(avatarUrl ? { avatarUrl } : {}), token: String(e.sharedSecret || ''), inviterProfileId: profileOf ? profileOf[1] : '', firstName: String(person.firstName || title.split(' ')[0] || '') };
    });

    return { conversations, invitations };
`;

/** An activity urn the thread already trusts, or a refusal. Anything else never reaches the page. */
export function linkedinActivityUrn(value: unknown): string {
  if (typeof value === 'string' && /^urn:li:activity:\d+$/.test(value)) return value;
  throw new Error('That is not a LinkedIn post this plugin can read.');
}

/**
 * One feed update, reduced in the page. Captured 2026-11-10: `GET /voyager/api/feed/updates/{urn}`
 * answers `UpdateV2`. The words are `commentary.text.text`, the author is `actor.name.text`, and the
 * picture is the first content image's `vectorImage` (`rootUrl` plus the last artifact). The card
 * keeps the start of a long commentary. The actor's own face is not the post picture.
 */
const POST_BODY = `
    const enc = u => encodeURIComponent(u).replace(/\\(/g, '%28').replace(/\\)/g, '%29');
    const pair = (document.cookie.split('; ').find(c => c.startsWith('JSESSIONID=')) || '').split('=')[1] || '';
    const headers = { 'csrf-token': decodeURIComponent(pair).replace(/^"|"$/g, ''), accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' };
    const get = async url => { const response = await fetch(url, { headers, credentials: 'include' }); if (!response.ok) throw new Error('LinkedIn ' + response.status + ' for ' + url.split('?')[0]); return JSON.parse(await response.text()); };
    const linkedinImage = value => {
      try { const url = new URL(String(value)); return url.protocol === 'https:' && (url.hostname === 'licdn.com' || url.hostname.endsWith('.licdn.com')) ? url.href : ''; }
      catch { return ''; }
    };
    const imageOf = vector => {
      const display = vector || {};
      const identifiers = (display.elements || []).flatMap(element => element.identifiers || []).map(value => value.identifier).filter(value => typeof value === 'string');
      const direct = identifiers.find(value => value.startsWith('https://'));
      if (direct) return linkedinImage(direct);
      const root = String(display.rootUrl || '');
      const path = (display.artifacts || []).map(value => value.fileIdentifyingUrlPathSegment).filter(value => typeof value === 'string').at(-1);
      return root && path ? linkedinImage(root + path) : '';
    };
    const clip = (value, limit) => String(value || '').trim().slice(0, limit);
    const json = await get('/voyager/api/feed/updates/' + enc(urn));
    const update = (json.included || []).find(item => item && item.$type === 'com.linkedin.voyager.feed.render.UpdateV2');
    if (!update) throw new Error('LinkedIn did not return that post.');
    const vector = update.content && Array.isArray(update.content.images) ? update.content.images[0]?.attributes?.[0]?.vectorImage : null;
    return { title: clip(update.commentary?.text?.text, 300), author: clip(update.actor?.name?.text, 200), imageUrl: imageOf(vector) };
`;

/** The page read for one shared post. A bad urn throws here, before any script is built. */
export function linkedinPostExpression(activityUrn: string): string {
  const urn = linkedinActivityUrn(activityUrn);
  return `(async () => {
  const urn = ${JSON.stringify(urn)};
  try {
    const payload = await (async (urn) => {${POST_BODY}})(urn);
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).split(String.fromCharCode(10))[0] };
  }
})()`;
}

/** A page count LinkedIn will answer, or a refusal: above the ceiling it answers an empty page. */
function olderCount(value: number): number {
  if (Number.isInteger(value) && value > 0 && value <= LINKEDIN_OLDER_PAGE_MAX) return value;
  throw new Error(`A LinkedIn older page is 1 to ${LINKEDIN_OLDER_PAGE_MAX} conversations.`);
}

/** Expression for BB's Browser-page API; evaluates in the already-open LinkedIn tab. */
export function linkedinPageExpression(read: LinkedInRead): string {
  // A read is validated before it is serialized, so what the page evaluates is always a well-formed
  // request: a cursor it would not know how to quote never becomes script text.
  const request = read.mode === 'older'
    ? { mode: 'older' as const, cursor: linkedinOlderCursor(read.cursor), count: olderCount(read.count) }
    : read;
  return `(async () => {
  const request = ${JSON.stringify(request)};
  try {
    const payload = await (async (request) => {${BODY}})(request);
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).split(String.fromCharCode(10))[0] };
  }
})()`;
}
