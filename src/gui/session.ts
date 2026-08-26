/** In-memory GUI session state. */

export interface GuiMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface GuiSession {
  activeHarnessName: string;
  modelId: string;
  conversationWindow: GuiMessage[];
}

export function createSession(): GuiSession {
  return {
    activeHarnessName: "local",
    modelId: "local",
    conversationWindow: [],
  };
}

export function appendConversation(session: GuiSession, message: GuiMessage): GuiSession {
  const next = [...session.conversationWindow, message];
  session.conversationWindow = next.slice(-20);
  return session;
}
