// Patch the pinned Baileys build before it is bundled (plan D7).
//
// Two edits to `baileys/lib/Utils/validate-connection.js`, both required for a
// desktop client to be a usable one:
//   - a Desktop/Mac-OS browser tuple reports Platform.MACOS instead of WEB, which is
//     what makes WhatsApp answer the `syncFullHistory` request with history rather
//     than nothing ("linked, and empty" in the research note);
//   - the Windows web sub-platform is WIN_HYBRID, the value the protocol expects
//     from a non-browser client.
//
// One edit to `baileys/lib/Socket/chats.js`: the picture query sends no privacy
// token. A token on that IQ makes WhatsApp ignore the request, so the ask waits
// out its timeout and the chat is stored with no link. The same query with no
// token is what already returns a link or a refusal. Other requests keep theirs.
//
// A plugin's `postinstall` is not a step the plugin controls — what ships is the
// bundle — so this runs from `npm run build` before `bb plugin build`. `--check`
// fails when the surrounding text moved, because a silent no-op here is a client
// that pairs and then shows an empty inbox.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baileysEntryUrl = import.meta.resolve('baileys');
const validateConnectionUrl = new URL('./Utils/validate-connection.js', baileysEntryUrl);
const chatsUrl = new URL('./Socket/chats.js', baileysEntryUrl);

const pictureTokenBlock = `        // WA Web only includes tctoken for user JIDs (not groups/newsletters)
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
        }`;

const pictureTokenFixed = `        // The picture query carries no privacy token. One on this IQ makes
        // WhatsApp ignore the request, and the ask then times out with no link.
        let content = baseContent;`;

const oldUserAgentStart = `const getUserAgent = (config) => {
    return {`;
const fixedUserAgentStart = `const isDesktop = (config) => config.browser[1] === 'Desktop';
const getUserAgentPlatform = (config) => {
    if (config.browser[1].toLocaleLowerCase().includes('android')) {
        return proto.ClientPayload.UserAgent.Platform.ANDROID;
    }
    if (config.syncFullHistory && isDesktop(config) && config.browser[0] === 'Mac OS') {
        return proto.ClientPayload.UserAgent.Platform.MACOS;
    }
    return proto.ClientPayload.UserAgent.Platform.WEB;
};
const getUserAgent = (config) => {
    return {`;

const replacements = [
  [oldUserAgentStart, fixedUserAgentStart],
  ['        platform: proto.ClientPayload.UserAgent.Platform.WEB,', '        platform: getUserAgentPlatform(config),'],
  ['    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN32', '    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID'],
];

export function isPatched(source) {
  return source.includes(fixedUserAgentStart)
    && source.includes('        platform: getUserAgentPlatform(config),')
    && source.includes('    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID');
}

export function patchBaileysSource(source) {
  if (isPatched(source)) return source;
  let patched = source;
  for (const [before, after] of replacements) {
    if (!patched.includes(before)) {
      throw new Error(`Unsupported Baileys validate-connection.js layout; missing: ${before.split('\n')[0]}`);
    }
    patched = patched.replace(before, after);
  }
  if (!isPatched(patched)) throw new Error('Baileys connection patch did not apply completely');
  return patched;
}

export function isProfilePicturePatched(source) {
  return source.includes(pictureTokenFixed) && !source.includes(pictureTokenBlock);
}

export function patchProfilePictureSource(source) {
  if (isProfilePicturePatched(source)) return source;
  if (!source.includes(pictureTokenBlock)) {
    throw new Error('Unsupported Baileys chats.js layout; the picture query no longer matches');
  }
  const patched = source.replace(pictureTokenBlock, pictureTokenFixed);
  if (!isProfilePicturePatched(patched)) throw new Error('Baileys picture patch did not apply completely');
  return patched;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = await readFile(validateConnectionUrl, 'utf8');
  const chats = await readFile(chatsUrl, 'utf8');
  if (process.argv.includes('--check')) {
    if (!isPatched(source)) throw new Error('Baileys desktop pairing compatibility patch is not installed');
    if (!isProfilePicturePatched(chats)) throw new Error('Baileys picture query still carries a privacy token');
    console.log('Baileys patch present.');
  } else {
    const patched = patchBaileysSource(source);
    if (patched !== source) {
      await writeFile(validateConnectionUrl, patched);
      console.log(`Patched ${fileURLToPath(validateConnectionUrl)} for current desktop pairing`);
    }
    const patchedChats = patchProfilePictureSource(chats);
    if (patchedChats !== chats) {
      await writeFile(chatsUrl, patchedChats);
      console.log(`Patched ${fileURLToPath(chatsUrl)} so a picture query carries no privacy token`);
    }
    if (patched === source && patchedChats === chats) console.log('Baileys patch already present.');
  }
}
