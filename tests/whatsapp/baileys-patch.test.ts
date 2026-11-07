// A privacy token on the picture query makes WhatsApp ignore the request. The ask then
// waits out its timeout and the chat is stored with no link. The patch keeps that token
// off the picture query and leaves it on every other request.
import assert from 'node:assert/strict';
import test from 'node:test';
import { patchProfilePictureSource } from '../../_tools/patch-baileys.mjs';

const pictureQuery = `const profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
        const baseContent = [{ tag: 'picture', attrs: { type, query: 'url' } }];
        // WA Web only includes tctoken for user JIDs (not groups/newsletters)
        // and never for own profile pic (Chat model for self has no tcToken).
        // Including tctoken for own JID causes the server to never respond.
        const normalizedJid = jidNormalizedUser(jid);
        const isUserJid = isPnUser(normalizedJid) || isLidUser(normalizedJid);
        const me = authState.creds.me;
        const isSelf = me && (normalizedJid === jidNormalizedUser(me.id) || (me.lid && normalizedJid === jidNormalizedUser(me.lid)));
        let content = baseContent;
        if (serverProps.profilePicPrivacyToken && isUserJid && !isSelf) {
            content = await buildTcTokenFromJid({
                authState,
                jid: normalizedJid,
                baseContent,
                getLIDForPN
            });
        }
        jid = jidNormalizedUser(jid);
`;

const elsewhere = '/* other-request */ content = await buildTcTokenFromJid({ authState, jid: normalizedToJid, getLIDForPN });';

test('a picture query does not carry a privacy token', () => {
  const patched = patchProfilePictureSource(`${pictureQuery}${elsewhere}`);
  const picture = patched.slice(0, patched.indexOf('/* other-request */'));
  assert.equal(picture.includes('buildTcTokenFromJid'), false);
  assert.equal(picture.includes('profilePicPrivacyToken'), false);
  assert.match(patched, /other-request \*\/ content = await buildTcTokenFromJid/);
  assert.equal(patchProfilePictureSource(patched), patched);
});
