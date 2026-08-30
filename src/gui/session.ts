/** In-memory GUI session state. */

export interface GuiMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface GuiSession {
  activeHarnessName: string;
  modelId: string;
  conversationWindow: GuiMessage[];
  /** Recorded cloud-disclosure grants, keyed by `${provider}:${contextHash}`. */
  disclosedContexts: Set<string>;
  /** Recorded exact-tool approval grants for this session (task 32.8). */
  toolGrants: Set<string>;
}

export function createSession(): GuiSession {
  return {
    activeHarnessName: "local",
    modelId: "local",
    conversationWindow: [],
    disclosedContexts: new Set(),
    toolGrants: new Set(),
  };
}

export function appendConversation(session: GuiSession, message: GuiMessage): GuiSession {
  const next = [...session.conversationWindow, message];
  session.conversationWindow = next.slice(-20);
  return session;
}
