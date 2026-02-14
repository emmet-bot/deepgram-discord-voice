/**
 * Streaming LLM → TTS Pipeline
 *
 * Calls the Anthropic Messages API with streaming enabled, buffers text
 * until sentence boundaries, and fires a callback for each sentence so
 * TTS can start immediately without waiting for the full response.
 */

import type { DiscordVoiceConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamingLLMOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** Fires for each sentence-sized chunk as it becomes available */
  onSentence: (text: string) => void;
  /** Fires when the full response is complete (with the combined text) */
  onComplete: (fullText: string) => void;
  /** Fires on error */
  onError: (error: Error) => void;
  /** AbortSignal to cancel the stream (e.g. on barge-in) */
  signal?: AbortSignal;
}

export interface StreamHandle {
  /** Resolves when stream is fully consumed or aborted */
  done: Promise<void>;
  /** Abort the in-flight stream */
  abort: () => void;
}

// ---------------------------------------------------------------------------
// Conversation memory (in-memory, per guild)
// ---------------------------------------------------------------------------

const conversationHistory = new Map<string, ConversationMessage[]>();

export function getHistory(guildId: string): ConversationMessage[] {
  return conversationHistory.get(guildId) ?? [];
}

export function addUserMessage(guildId: string, text: string, maxLen: number): void {
  let hist = conversationHistory.get(guildId);
  if (!hist) {
    hist = [];
    conversationHistory.set(guildId, hist);
  }
  hist.push({ role: "user", content: text });
  trimHistory(hist, maxLen);
}

export function addAssistantMessage(guildId: string, text: string, maxLen: number): void {
  const hist = conversationHistory.get(guildId);
  if (hist) {
    hist.push({ role: "assistant", content: text });
    trimHistory(hist, maxLen);
  }
}

export function clearHistory(guildId: string): void {
  conversationHistory.delete(guildId);
}

function trimHistory(hist: ConversationMessage[], maxLen: number): void {
  while (hist.length > maxLen) {
    hist.shift();
  }
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/** Abbreviations we should NOT split on */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
  "vs", "etc", "inc", "ltd", "co", "corp",
  "e.g", "i.e", "fig", "vol", "dept", "est",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
]);

/**
 * Try to find a sentence boundary in `buffer`.
 * Returns the index *after* the boundary punctuation + space (the split point),
 * or -1 if no valid boundary is found.
 */
function findSentenceBoundary(buffer: string): number {
  // Look for ". ", "! ", "? ", ".\n", "!\n", "?\n"
  const re = /([.!?])([\s\n])/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(buffer)) !== null) {
    const punctIdx = match.index;
    const splitAt = punctIdx + match[0].length;

    // Skip if this looks like an abbreviation
    if (match[1] === ".") {
      // Walk backward to find the word before the dot
      let wordStart = punctIdx - 1;
      while (wordStart >= 0 && /[a-zA-Z.]/.test(buffer[wordStart])) {
        wordStart--;
      }
      const word = buffer.slice(wordStart + 1, punctIdx).toLowerCase();
      if (ABBREVIATIONS.has(word)) continue;
      // Decimal numbers like "3.5" — skip if digit before dot and digit after
      if (punctIdx > 0 && /\d/.test(buffer[punctIdx - 1]) && splitAt < buffer.length && /\d/.test(buffer[splitAt])) {
        continue;
      }
    }

    return splitAt;
  }

  return -1;
}

const MIN_CHUNK_LENGTH = 20;

// ---------------------------------------------------------------------------
// SSE parser helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parse raw SSE text into events.
 * Handles multi-line data and event names.
 */
function parseSSEChunk(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = raw.split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data += (data ? "\n" : "") + line.slice(6);
      } else if (line === "data:") {
        data += (data ? "\n" : "");
      }
    }
    if (event || data) {
      events.push({ event, data });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Core streaming function
// ---------------------------------------------------------------------------

/**
 * Start a streaming request to the Anthropic Messages API.
 * Text delta tokens are accumulated and emitted at sentence boundaries.
 */
export function streamLLMResponse(
  messages: ConversationMessage[],
  opts: StreamingLLMOptions,
): StreamHandle {
  const controller = new AbortController();
  const combinedSignal = opts.signal
    ? combineAbortSignals(controller.signal, opts.signal)
    : controller.signal;

  const done = (async () => {
    let textBuffer = "";
    let fullText = "";

    try {
      // Strip "anthropic/" prefix from model if present
      let model = opts.model;
      const slashIdx = model.indexOf("/");
      if (slashIdx !== -1) {
        model = model.slice(slashIdx + 1);
      }

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          system: opts.systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal: combinedSignal,
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`Anthropic API error ${resp.status}: ${errBody}`);
      }

      if (!resp.body) {
        throw new Error("Anthropic response missing body stream");
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      for (;;) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const events = parseSSEChunk(sseBuffer);

        // Keep any incomplete event at the end (no trailing \n\n)
        const lastDoubleNewline = sseBuffer.lastIndexOf("\n\n");
        if (lastDoubleNewline !== -1) {
          sseBuffer = sseBuffer.slice(lastDoubleNewline + 2);
        }

        for (const sse of events) {
          if (sse.event === "content_block_delta") {
            try {
              const parsed = JSON.parse(sse.data) as {
                delta?: { type?: string; text?: string };
              };
              if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
                textBuffer += parsed.delta.text;
                fullText += parsed.delta.text;

                // Try to emit complete sentences
                let boundary: number;
                while ((boundary = findSentenceBoundary(textBuffer)) !== -1) {
                  const sentence = textBuffer.slice(0, boundary).trim();
                  textBuffer = textBuffer.slice(boundary);
                  if (sentence.length >= MIN_CHUNK_LENGTH) {
                    opts.onSentence(sentence);
                  } else if (sentence.length > 0) {
                    // Too short — keep buffered and try next boundary
                    textBuffer = sentence + " " + textBuffer;
                    break;
                  }
                }
              }
            } catch {
              // Ignore malformed JSON
            }
          } else if (sse.event === "message_stop") {
            // Stream finished
          }
        }
      }

      // Flush remaining buffer
      const remaining = textBuffer.trim();
      if (remaining.length > 0) {
        opts.onSentence(remaining);
      }

      opts.onComplete(fullText);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // Aborted (barge-in) — flush whatever we have as the complete text
        const remaining = textBuffer.trim();
        if (remaining.length > 0) {
          opts.onSentence(remaining);
        }
        opts.onComplete(fullText);
        return;
      }
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    done,
    abort: () => controller.abort(),
  };
}

// ---------------------------------------------------------------------------
// Resolve Anthropic API key
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function resolveAnthropicApiKey(cfg: DiscordVoiceConfig): string | null {
  // 1. Plugin config
  if (cfg.anthropicApiKey) return cfg.anthropicApiKey;

  // 2. Environment variable
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // 3. Credentials file
  const credPath = path.join(os.homedir(), ".openclaw", "credentials", "claude-code-anthropic-api-key.txt");
  try {
    const key = fs.readFileSync(credPath, "utf8").trim();
    if (key) return key;
  } catch {
    // File doesn't exist
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  if (a.aborted || b.aborted) controller.abort();
  return controller.signal;
}
