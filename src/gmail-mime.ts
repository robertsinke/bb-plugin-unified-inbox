import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export type GmailDraft = { from:string; to:string; cc:string; bcc:string; subject:string; text:string; inReplyTo?:string; references?:string };
// Gmail delivers to the headers of the raw message it is given, so the blind copy has to stay
// in the MIME. nodemailer strips Bcc by default (right for SMTP envelopes, wrong here).
export async function buildGmailMime(input: GmailDraft): Promise<Buffer> {
  for (const value of [input.from,input.to,input.cc,input.bcc,input.subject,input.inReplyTo ?? '',input.references ?? '']) {
    if (/[\r\n\0]/.test(value)) throw new Error('Invalid mail header');
  }
  const message = new MailComposer({from:input.from,to:input.to,cc:input.cc||undefined,bcc:input.bcc||undefined,subject:input.subject,text:input.text,inReplyTo:input.inReplyTo||undefined,references:input.references||undefined}).compile();
  // nodemailer drops Bcc from the generated headers unless asked (right for an SMTP envelope,
  // wrong for Gmail, which delivers to the headers of the raw message we hand it). The flag
  // lives on the MIME node, not on the composer options, so it is set here rather than passed in.
  message.rootNode.keepBcc = true;
  return message.build();
}
