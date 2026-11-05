import { useState } from 'react';
import { Qr } from '../components/ui/qr.tsx';
import type { WhatsAppPairingSnapshot } from './rpc-contract.ts';

/**
 * What the owner is agreeing to, in three sentences, drawn before any code appears (plan R8).
 *
 * This is not a link and not a tooltip: a person who has never seen this plugin scans a QR that links
 * a device to their account, and the thing they are agreeing to is the sentence they can read here.
 * The wording is the research note's — the mechanism is the same one WhatsApp Web uses, the triggers
 * are WhatsApp's, and the plugin controls exactly one of them.
 */
export const EXPOSURE_NOTE =
  'This counts as a linked device, like WhatsApp Web. WhatsApp prohibits bulk and automated messaging '
  + 'and has banned linked-device sessions, and this plugin cannot prevent that. It keeps one connection, '
  + 'never re-pairs on its own, and sends only when you ask it to.';

/** The QR is the default way in; a code typed on the phone is the fallback, offered on request only. */
function PhoneFallback({ busy, onCode }: { busy: boolean; onCode: (phone: string) => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const digits = phone.replace(/\D/g, '');
  if (!open) {
    return (
      <button type="button" className="ui-text-button" onClick={() => setOpen(true)}>
        Use a phone number instead
      </button>
    );
  }
  return (
    <form
      className="ui-pairing-phone"
      onSubmit={(event) => {
        event.preventDefault();
        if (digits.length >= 7 && digits.length <= 15) onCode(digits);
      }}
    >
      <label htmlFor="ui-pairing-phone">Phone number, with country code</label>
      <input
        id="ui-pairing-phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="31612345678"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
      />
      <button type="submit" className="ui-text-button" disabled={busy || digits.length < 7 || digits.length > 15}>
        Get a pairing code
      </button>
    </form>
  );
}

export interface WhatsAppPairingCardProps {
  pairing: WhatsAppPairingSnapshot;
  busy: boolean;
  onPair: () => void;
  onCode: (phone: string) => void;
  onRePair: () => void;
  onReconnect: () => void;
}

/**
 * The pairing card: one state, one action, and the exposure note above both.
 *
 * Everything it draws comes from the pairing state the gateway answered. It decides no fact about the
 * socket, so a state it does not recognise draws the note and nothing to press, rather than a spinner
 * that claims to know what is happening.
 */
export function WhatsAppPairingCard({ pairing, busy, onPair, onCode, onRePair, onReconnect }: WhatsAppPairingCardProps) {
  const state = pairing.state;
  if (state === 'connected') return null;
  return (
    <section className="ui-pairing" aria-labelledby="ui-pairing-title">
      <h3 id="ui-pairing-title">Connect WhatsApp</h3>
      <p className="ui-pairing-note">{EXPOSURE_NOTE}</p>

      {state === 'unpaired' ? (
        <>
          <p className="ui-pairing-state">WhatsApp is not linked on this machine yet.</p>
          <button type="button" className="ui-text-button" disabled={busy} onClick={onPair}>
            Show the QR code
          </button>
        </>
      ) : null}

      {state === 'logged-out' ? (
        <>
          <p className="ui-pairing-state">
            This phone is no longer linked to WhatsApp. Linking it again counts as a new device.
          </p>
          <button type="button" className="ui-text-button" disabled={busy} onClick={onRePair}>
            Pair again
          </button>
        </>
      ) : null}

      {state === 'connecting' ? (
        <p className="ui-pairing-state" role="status">Asking WhatsApp for a code…</p>
      ) : null}

      {state === 'failed' ? (
        <>
          <p className="ui-pairing-state">
            This phone is still linked, but the plugin could not open its WhatsApp connection.
          </p>
          <button type="button" className="ui-text-button" disabled={busy} onClick={onReconnect}>
            Try again
          </button>
        </>
      ) : null}

      {state === 'qr' && pairing.qr ? (
        <>
          <p className="ui-pairing-state">
            Open WhatsApp on your phone under Linked devices, choose Link a device, then point it at this code.
          </p>
          <Qr value={pairing.qr} label="WhatsApp pairing code; scan it with your phone" />
          <p className="ui-pairing-hint">This code changes every twenty seconds; an expired one is never shown.</p>
        </>
      ) : null}

      {state === 'code' && pairing.code ? (
        <>
          <p className="ui-pairing-state">Enter these characters on your phone under Linked devices.</p>
          <p className="ui-pairing-code">{pairing.code}</p>
        </>
      ) : null}

      {pairing.message ? <p className="ui-pairing-message" role="status">{pairing.message}</p> : null}

      {state === 'connecting' || state === 'qr' ? <PhoneFallback busy={busy} onCode={onCode} /> : null}
      {state === 'code' ? (
        <button type="button" className="ui-text-button" disabled={busy} onClick={onPair}>
          Show the QR code instead
        </button>
      ) : null}
    </section>
  );
}
