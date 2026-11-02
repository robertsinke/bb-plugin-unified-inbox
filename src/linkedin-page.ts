import { CONVERSATION_URN_SOURCE } from './linkedin-conversation.ts';

/**
 * In-page read of LinkedIn's own inbox, run inside the BB browser's signed-in session.
 *
 * The session never leaves the browser and nothing is clicked: no conversation is opened,
 * no invitation is accepted, and no message is sent. The requests are the same ones the
 * LinkedIn web app makes on load — messaging inbox, one conversation's messages, received
 * invitations, and display names.
 */
export type LinkedInRead = { mode: 'list' } | { mode: 'thread'; id: string } | { mode: 'probe'; mailbox?: string };

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
        return { id: String(e.entityUrn || ''), sender: mine ? 'You' : names.get(key) || 'LinkedIn', text: String(e.body?.text || e.renderContentFallbackText || ''), date: Number(e.deliveredAt || 0), fromMe: mine, mediaUrl: photoOf(e), activityUrn: activityOf(e) };
      }) };
    }

    const inbox = await get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.0d5e6781bbee71c3e51c8843c6519f48&variables=(mailboxUrn:' + enc(meRef.replace('fs_miniProfile', 'fsd_profile')) + ')');
    const entities = (inbox.included || []).filter(e => conversationUrn.test(String(e.entityUrn || '')));
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
    const previews = new Map();
    for (const item of inbox.included || []) {
      if (!/linkedin\.messenger\.Message$/.test(String(item.$type || ''))) continue;
      const key = String(item['*conversation'] || '');
      const body = previewOf(item);
      if (!key || !body) continue;
      const at = Number(item.deliveredAt || 0);
      const seen = previews.get(key);
      if (!seen || at >= seen.at) previews.set(key, { at, body });
    }
    const counterparts = [...new Set(entities.flatMap(e => e['*conversationParticipants'] || []).filter(ref => { const key = identityKey(ref); return key && key !== meKey; }))];
    await Promise.all(counterparts.map(nameOf));
    const conversations = entities.map(e => {
      const others = (e['*conversationParticipants'] || []).filter(ref => { const key = identityKey(ref); return key && key !== meKey; });
      const people = others.map(ref => names.get(identityKey(ref))).filter(Boolean).join(', ');
      const avatarUrl = others.length === 1 ? avatars.get(identityKey(others[0])) : '';
      const preview = String(e.descriptionText || '') || previews.get(String(e.entityUrn))?.body || '';
      return { id: String(e.entityUrn), title: String(e.title || '') || people, preview, date: Number(e.lastActivityAt || 0), unread: Number(e.unreadCount || 0) > 0, sender: people, ...(avatarUrl ? { avatarUrl } : {}) };
    });

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

/** Expression for BB's Browser-page API; evaluates in the already-open LinkedIn tab. */
export function linkedinPageExpression(read: LinkedInRead): string {
  return `(async () => {
  const request = ${JSON.stringify(read)};
  try {
    const payload = await (async (request) => {${BODY}})(request);
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).split(String.fromCharCode(10))[0] };
  }
})()`;
}
