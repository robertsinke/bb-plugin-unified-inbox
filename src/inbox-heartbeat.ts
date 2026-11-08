// When the panel calls `tick`. The session decides what is due. This module only
// decides whether the page is on screen.
//
// A desktop document that is not visible does not tick. The phone app's webview
// reports hidden while the inbox is on screen, and the operating system stops
// the timer when that app is in the background, so the shell keeps ticking until
// the page itself hides.

interface PhoneShell {
  native?: {
    subscribe?: (listener: (event: { type?: string }) => void) => () => void;
  };
}

function phoneShell(view: Window): PhoneShell['native'] | undefined {
  const root = (view as Window & { bb?: PhoneShell }).bb;
  const native = root?.native;
  return typeof native?.subscribe === 'function' ? native : undefined;
}

export function startInboxHeartbeat(session: { tick(now: number): void; flush(): void }, view: Window): () => void {
  const shell = phoneShell(view);
  // The shell is on screen for as long as its page is loaded. A desktop tab is
  // on screen only while the document says so.
  let shown = shell !== undefined || view.document.visibilityState === 'visible';
  const beat = () => {
    if (!shown) return;
    if (shell === undefined && view.document.visibilityState !== 'visible') return;
    session.tick(Date.now());
  };
  const show = () => {
    if (shell === undefined && view.document.visibilityState !== 'visible') return;
    shown = true;
    session.tick(Date.now());
  };
  const onVisibility = () => {
    if (view.document.visibilityState === 'hidden') {
      // The phone webview sends this while the inbox is on screen. Save the
      // draft, and leave the beat running. A desktop tab really did go away.
      if (shell === undefined) shown = false;
      session.flush();
      return;
    }
    if (view.document.visibilityState === 'visible') show();
  };
  const onPageHide = () => {
    shown = false;
    session.flush();
  };
  const onResume = (event: { type?: string }) => {
    if (event?.type === 'resume') show();
  };
  const timer = view.setInterval(beat, 1_000);
  view.addEventListener('pagehide', onPageHide);
  view.addEventListener('pageshow', show);
  view.addEventListener('focus', show);
  view.document.addEventListener('visibilitychange', onVisibility);
  const stopResume = shell?.subscribe?.(onResume) ?? (() => {});
  return () => {
    view.clearInterval(timer);
    view.removeEventListener('pagehide', onPageHide);
    view.removeEventListener('pageshow', show);
    view.removeEventListener('focus', show);
    view.document.removeEventListener('visibilitychange', onVisibility);
    stopResume();
  };
}
