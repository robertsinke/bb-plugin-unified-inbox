import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export type GmailDraft = { from:string; to:string; cc:string; subject:string; text:string; inReplyTo?:string; references?:string };
export async function buildGmailMime(input: GmailDraft): Promise<Buffer> {
  for (const value of [input.from,input.to,input.cc,input.subject,input.inReplyTo ?? '',input.references ?? '']) {
    if (/[\r\n\0]/.test(value)) throw new Error('Invalid mail header');
  }
  return new MailComposer({from:input.from,to:input.to,cc:input.cc||undefined,subject:input.subject,text:input.text,inReplyTo:input.inReplyTo||undefined,references:input.references||undefined}).compile().build();
}
