import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { MailAttachment, MailDraft } from './inbox-session.ts';
import { formatBytes } from './format.ts';

export type MailComposerProps = {
  mail: MailDraft;
  /** The account's name, so the form says whose draft this is. */
  accountLabel: string;
  busy: boolean;
  /** Why the last attempt did not send, or why a file was refused. */
  status: string;
  sendIcon: ReactNode;
  /** Files already in the open conversation, offered through the media reader. */
  fromThread?: { names: string[]; taking: string; onTake(name: string): void };
  onField(patch: Partial<MailDraft>): void;
  onAttach(file: MailAttachment): void;
  onDetach(index: number): void;
  onDiscard(): void;
  onSend(): void;
};

/**
 * The mail draft, in the slot a chat reply uses. Nothing here decides policy: the panel mints the
 * callbacks, the session owns the limits, and this is only the form the owner types into.
 */
export function MailComposer({ mail, accountLabel, busy, status, sendIcon, fromThread, onField, onAttach, onDetach, onDiscard, onSend }: MailComposerProps) {
  const files = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const [dropping, setDropping] = useState(false);
  const dropHint = useId();

  /** Reply, reply-all and forward open here. The cursor lands in the message, above any quoted text. */
  useLayoutEffect(() => {
    const field = body.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(0, 0);
  }, []);

  /** A picked or dropped file lives in this page: base64 in, no server round trip until a send. */
  async function read(picked: FileList | null): Promise<void> {
    if (!picked) return;
    for (const file of Array.from(picked)) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Could not read this file.'));
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
        reader.readAsDataURL(file);
      });
      onAttach({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, data });
    }
    if (files.current) files.current.value = '';
  }

  /** A drag has to be claimed here, or the browser opens the file and the panel is gone. */
  function over(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDropping(true);
  }

  /** Crossing between fields is still inside the form; only leaving the form ends the drop. */
  function leave(event: DragEvent<HTMLFormElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
  }

  /** A drop arrives through the same `read` the picker uses, so bytes become base64 in one place. */
  function drop(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDropping(false);
    const dropped = event.dataTransfer?.files;
    if (!dropped || dropped.length === 0) return;
    void read(dropped);
  }

  const ready = mail.to.trim() !== '' && (mail.text.trim() !== '' || mail.attachments.length > 0);
  return <form
    className={dropping ? 'ui-mail-composer is-dropping' : 'ui-mail-composer'}
    aria-label={`${accountLabel} draft`}
    aria-describedby={dropHint}
    onDragOver={over}
    onDragLeave={leave}
    onDragEnd={() => setDropping(false)}
    onDrop={drop}
    onSubmit={event => { event.preventDefault(); if (ready && !busy) onSend(); }}
  >
    <p id={dropHint} className="ui-sr">Files can be dropped onto this draft, or chosen with Attach.</p>
    {/* Same prompt box a chat reply uses. Mail adds the address rows above the message. */}
    <div className="ui-promptbox">
      <div className="ui-mail-fields">
        <label><span>To</span><input value={mail.to} aria-label="To" autoComplete="off" onChange={event => onField({ to: event.target.value })} /></label>
        <label><span>Cc</span><input value={mail.cc} aria-label="Cc" autoComplete="off" onChange={event => onField({ cc: event.target.value })} /></label>
        <label><span>Bcc</span><input value={mail.bcc} aria-label="Bcc" autoComplete="off" onChange={event => onField({ bcc: event.target.value })} /></label>
        <label><span>Subject</span><input value={mail.subject} aria-label="Subject" onChange={event => onField({ subject: event.target.value })} /></label>
      </div>
      {mail.attachments.length > 0 && <ul className="ui-attachment-list" aria-label="Attachments">{mail.attachments.map((file, index) => (
        <li key={`${file.name}:${index}`} className="ui-attachment-chip">
          <span className="ui-attachment-name">{file.name}</span>
          <span className="ui-attachment-size">{formatBytes(file.size)}</span>
          <button type="button" className="ui-attachment-drop" onClick={() => onDetach(index)} aria-label={`Remove ${file.name}`} title="Remove">×</button>
        </li>
      ))}</ul>}
      {fromThread && fromThread.names.length > 0 && <div className="ui-attachment-offer">
        <span>In this conversation:</span>
        {fromThread.names.map(name => (
          <button key={name} type="button" className="ui-attachment-take" disabled={fromThread.taking !== ''} title="Take this attachment from the conversation through the media reader" onClick={() => fromThread.onTake(name)}>
            {fromThread.taking === name ? 'Adding…' : `+ ${name}`}
          </button>
        ))}
      </div>}
      <textarea ref={body} className="ui-mail-body" rows={3} value={mail.text} aria-label="Message" placeholder="Write a message…" onChange={event => onField({ text: event.target.value })} />
      <div className="ui-mail-actions">
        <button type="button" className="ui-icon-button" disabled={busy} onClick={() => files.current?.click()} aria-label="Attach" title="Attach"><Icon name="Paperclip" aria-hidden="true" /></button>
        <input ref={files} type="file" multiple className="ui-file-input" onChange={event => void read(event.target.files)} aria-label="Choose files to attach" />
        <span className="ui-mail-actions-spacer" />
        <button type="button" className="ui-icon-button" disabled={busy} onClick={onDiscard} aria-label="Discard" title="Discard"><Icon name="Trash2" aria-hidden="true" /></button>
        <button type="submit" className="ui-prompt-send" disabled={busy || !ready} title={ready ? `Send from ${accountLabel}` : 'Add a recipient and a message or file first'} aria-label="Send">{sendIcon}</button>
      </div>
    </div>
    {status ? <p className="ui-notice" role="status">{status}</p> : null}
  </form>;
}
