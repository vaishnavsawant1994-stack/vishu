export type ApiMethod = "GET" | "POST" | "DELETE";

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface Health {
  status: "ok";
  service: string;
  configured_model: string;
}

export interface ChatResponse {
  conversation_id: string;
  assistant: string;
  model: string;
}

declare global {
  interface Window {
    vishu?: {
      request: (method: ApiMethod, path: string, body?: unknown) => Promise<unknown>;
      openTextFile: () => Promise<{name: string; content: string} | null>;
      openSelectedText: () => Promise<{opened: boolean; cancelled?: boolean}>;
      chatStream: (streamId: string, body: {text: string; conversation_id: string | null}) =>
        Promise<{complete: boolean; cancelled?: boolean}>;
      cancelStream: (streamId: string) => void;
      onChatStream: (callback: (event: {
        streamId: string;
        type: "delta" | "done" | "error";
        text?: string;
        message?: string;
        conversation_id?: string;
        model?: string;
      }) => void) => () => void;
    };
  }
}

export async function request<T>(
  method: ApiMethod,
  path: string,
  body?: unknown
): Promise<T> {
  if (!window.vishu) {
    throw new Error(
      "VISHU desktop bridge is unavailable. Launch the desktop app with npm run dev; " +
      "a standalone browser does not have access to the private local API."
    );
  }
  return (await window.vishu.request(method, path, body)) as T;
}
