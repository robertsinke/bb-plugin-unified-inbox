import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, WhatsAppPairingRequest, WhatsAppPairingSnapshot } from './rpc-contract.ts';
import { EXPOSURE_NOTE, WhatsAppPairingCard } from './whatsapp-pairing.tsx';

/** A QR rotates every 20 s. The poll is the same pace the inbox card used, and it stops when this section unmounts. */
export const PAIRING_POLL_MS = 2_000;

const MESSAGES_EMPTY = 'Check that imsg is installed and BB has Full Disk Access.';
const TESTING_CLIENT = 'A Testing client expires after 7 days.';
const RECONNECT_CONFIRM = 'This signs in again and replaces the local file for the Google account that answers. A Testing client expires after 7 days.';

type ConnectionStatus = {
  clientConfigured: boolean;
  mailboxes: Array<{ account: string; lastError?: { at: number; message: string } }>;
  whatsapp: WhatsAppPairingSnapshot;
  linkedin: { lastSuccessAt: number | null; lastError: string | null };
  messages: string;
};

type Pending = { kind: 'reconnect' | 'remove'; account: string } | { kind: 'unpair' };

function gmailError(message: string): string {
  if (!message.includes('invalid_grant') || message.includes(TESTING_CLIENT)) return message;
  return `${message} ${TESTING_CLIENT}`;
}

function Confirm({ text, onConfirm, onDismiss }: { text: string; onConfirm: () => void; onDismiss: () => void }) {
  return (
    <div className="ui-confirm">
      <p>{text}</p>
      <button type="button" className="ui-text-button" onClick={onConfirm}>Confirm</button>
      <button type="button" className="ui-text-button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/**
 * The connect screen under the host's client fields.
 * It does not import the inbox. Leaving the page does not delete a file the server already wrote.
 */
export function AccountSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const alive = useRef(true);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailNote, setGmailNote] = useState('');
  const [linkedinBusy, setLinkedinBusy] = useState(false);
  const [linkedinNote, setLinkedinNote] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [whatsappNote, setWhatsappNote] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const answer = await rpcRef.current.call('connection_status', null);
        if (alive.current && answer) setStatus(answer);
      } catch (error) {
        if (alive.current) setLoadError(error instanceof Error ? error.message : 'Could not read connection status.');
      }
    })();
    // Unmount stops the poll below. It does not cancel sign-in and it does not unpair.
    return () => { alive.current = false; };
  }, []);

  const pairingState = status?.whatsapp.state;
  useEffect(() => {
    if (pairingState !== 'connecting' && pairingState !== 'qr' && pairingState !== 'code') return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const answer = await rpcRef.current.call('whatsapp_pairing', null);
          if (!alive.current || !answer) return;
          setStatus(current => current ? { ...current, whatsapp: answer } : current);
        } catch { /* the card keeps the snapshot it has */ }
      })();
    }, PAIRING_POLL_MS);
    return () => clearInterval(timer);
  }, [pairingState]);

  async function refresh() {
    const next = await rpcRef.current.call('connection_status', null);
    if (alive.current && next) setStatus(next);
  }

  async function addMailbox() {
    setGmailBusy(true);
    setGmailNote('');
    try {
      const result = await rpcRef.current.call('gmail_connect', null);
      if (!alive.current) return;
      setGmailNote(result?.alreadyConnected ? 'This mailbox is already connected.' : '');
      await refresh();
    } catch (error) {
      if (alive.current) setGmailNote(error instanceof Error ? error.message : 'Gmail sign-in did not finish.');
    } finally {
      if (alive.current) setGmailBusy(false);
    }
  }

  async function cancelMailbox() {
    try {
      await rpcRef.current.call('gmail_connect_cancel', null);
    } catch (error) {
      if (alive.current) setGmailNote(error instanceof Error ? error.message : 'Gmail sign-in did not cancel.');
    }
  }

  async function reconnect() {
    setPending(null);
    setGmailBusy(true);
    setGmailNote('');
    try {
      const result = await rpcRef.current.call('gmail_connect', { replace: true });
      if (!alive.current) return;
      setGmailNote(result?.alreadyConnected ? 'This mailbox is already connected.' : '');
      await refresh();
    } catch (error) {
      if (alive.current) setGmailNote(error instanceof Error ? error.message : 'Gmail sign-in did not finish.');
    } finally {
      if (alive.current) setGmailBusy(false);
    }
  }

  async function removeMailbox(account: string) {
    setPending(null);
    try {
      await rpcRef.current.call('gmail_remove', { account });
      if (!alive.current) return;
      await refresh();
    } catch (error) {
      if (alive.current) setGmailNote(error instanceof Error ? error.message : 'Could not remove that mailbox.');
    }
  }

  async function actWhatsApp(request: WhatsAppPairingRequest) {
    setPairingBusy(true);
    setWhatsappNote('');
    try {
      const answer = await rpcRef.current.call('whatsapp_pairing', request);
      if (alive.current && answer) setStatus(current => current ? { ...current, whatsapp: answer } : current);
    } catch (error) {
      if (alive.current) setWhatsappNote(error instanceof Error ? error.message : 'WhatsApp did not answer.');
    } finally {
      if (alive.current) setPairingBusy(false);
    }
  }

  async function signInLinkedIn() {
    setLinkedinBusy(true);
    setLinkedinNote('');
    try {
      await rpcRef.current.call('linkedin_signin', null);
      if (!alive.current) return;
      const next = await rpcRef.current.call('connection_status', null);
      if (!alive.current || !next) return;
      setStatus(next);
      const row = next.linkedin;
      if (row.lastSuccessAt != null && !row.lastError) setLinkedinNote('The last read worked.');
      else if (row.lastError) setLinkedinNote(row.lastError);
    } catch (error) {
      if (alive.current) setLinkedinNote(error instanceof Error ? error.message : 'LinkedIn sign-in did not finish.');
    } finally {
      if (alive.current) setLinkedinBusy(false);
    }
  }

  if (!status) {
    return <p className="ui-account-settings" role="status">{loadError || 'Reading accounts…'}</p>;
  }

  const linkedinLine = linkedinBusy
    ? 'The sign-in window is opening.'
    : linkedinNote || (status.linkedin.lastError ?? (status.linkedin.lastSuccessAt != null ? 'The last read worked.' : ''));
  const messages = status.messages.trim() ? status.messages : MESSAGES_EMPTY;
  const whatsapp = status.whatsapp;

  return (
    <div className="ui-account-settings">
      <section className="ui-account-block" aria-labelledby="ui-gmail-title">
        <h3 id="ui-gmail-title">Gmail</h3>
        {!status.clientConfigured ? <p>Fill in the client id and secret above.</p> : null}
        {gmailBusy ? <p role="status">The system browser is open.</p> : null}
        {gmailNote ? <p className="ui-gmail-note" role="status">{gmailNote}</p> : null}
        <ul>
          {status.mailboxes.map(row => (
            <li key={row.account} data-account={row.account}>
              <span>{row.account}</span>
              {row.lastError ? <p className="ui-gmail-error">{gmailError(row.lastError.message)}</p> : null}
              {pending?.kind === 'reconnect' && pending.account === row.account ? (
                <Confirm text={RECONNECT_CONFIRM} onConfirm={() => void reconnect()} onDismiss={() => setPending(null)} />
              ) : (
                <button type="button" className="ui-text-button" disabled={gmailBusy} onClick={() => setPending({ kind: 'reconnect', account: row.account })}>Reconnect</button>
              )}
              {pending?.kind === 'remove' && pending.account === row.account ? (
                <Confirm text={`Remove ${row.account}? This deletes the local credential for that mailbox.`} onConfirm={() => void removeMailbox(row.account)} onDismiss={() => setPending(null)} />
              ) : (
                <button type="button" className="ui-text-button" disabled={gmailBusy} onClick={() => setPending({ kind: 'remove', account: row.account })}>Remove</button>
              )}
            </li>
          ))}
        </ul>
        <button type="button" className="ui-text-button" disabled={!status.clientConfigured || gmailBusy} onClick={() => { if (!status.clientConfigured || gmailBusy) return; void addMailbox(); }}>Add</button>
        {gmailBusy ? <button type="button" className="ui-text-button" onClick={() => void cancelMailbox()}>Cancel</button> : null}
      </section>

      <section className="ui-account-block" aria-label="WhatsApp">
        {whatsapp.state === 'connected' ? (
          <>
            <h3>WhatsApp</h3>
            <p className="ui-whatsapp-state">WhatsApp is connected on this machine.</p>
            {pending?.kind === 'unpair' ? (
              <Confirm text={EXPOSURE_NOTE} onConfirm={() => { setPending(null); void actWhatsApp({ op: 'unpair' }); }} onDismiss={() => setPending(null)} />
            ) : (
              <button type="button" className="ui-text-button" disabled={pairingBusy} onClick={() => setPending({ kind: 'unpair' })}>Unpair</button>
            )}
          </>
        ) : (
          <WhatsAppPairingCard
            pairing={whatsapp}
            busy={pairingBusy}
            onPair={() => void actWhatsApp({ op: 'pair' })}
            onCode={phone => void actWhatsApp({ op: 'request-code', phone })}
            onRePair={() => void actWhatsApp({ op: 'unpair' }).then(() => actWhatsApp({ op: 'pair' }))}
            onReconnect={() => void actWhatsApp({ op: 'reconnect' })}
          />
        )}
        {whatsappNote ? <p className="ui-whatsapp-note" role="status">{whatsappNote}</p> : null}
      </section>

      <section className="ui-account-block" aria-labelledby="ui-linkedin-title">
        <h3 id="ui-linkedin-title">LinkedIn</h3>
        {linkedinLine ? <p className="ui-linkedin-status" role="status">{linkedinLine}</p> : null}
        <button type="button" className="ui-text-button" disabled={linkedinBusy} onClick={() => void signInLinkedIn()}>Sign in</button>
      </section>

      <section className="ui-account-block" aria-labelledby="ui-messages-title">
        <h3 id="ui-messages-title">Messages</h3>
        <p className="ui-messages-status">{messages}</p>
      </section>
    </div>
  );
}
