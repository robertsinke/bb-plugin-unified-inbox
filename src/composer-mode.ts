/**
 * Which composer the panel shows. One decision, in one place, because getting it wrong is invisible:
 * a draft that matches no branch simply renders nowhere, which is exactly what a forward did when
 * the panel only accepted a draft whose thread id matched the open conversation.
 */
export type ComposerMode = 'mail' | 'chat' | 'compose' | 'none';

export function composerMode(input: {
  /** A conversation is open. */
  selected: boolean;
  /** A mail draft exists. */
  draft: boolean;
  /** The draft is a reply to the open conversation rather than a new message or forward. */
  draftForThisThread: boolean;
  /** The open conversation reads as a thread of messages rather than a document. */
  threaded: boolean;
}): ComposerMode {
  const { selected, draft, draftForThisThread, threaded } = input;
  // A reply belongs to this conversation and a forward belongs to no thread yet: both are written
  // in the open conversation, which is the only place the owner is looking.
  if (selected && draft) return 'mail';
  if (selected) return threaded ? 'chat' : 'none';
  if (draft) return 'compose';
  return 'none';
}

/** Which conversation a draft belongs to when deciding where to write it. */
export function draftForConversation(threadId: string | undefined, conversationId: string | undefined): boolean {
  return threadId !== undefined && conversationId !== undefined && threadId === conversationId;
}
