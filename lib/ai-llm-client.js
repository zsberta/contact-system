// lib/ai-llm-client.js
//
// =============================================================================
// OpenAI-compatible streaming chat completions client.
//
// Used by routes/ai-assistant-embed.js to call the LLM configured per
// assistant (model, baseUrl, apiKey). The client POSTs to
// `${baseUrl}/chat/completions` with `stream: true` and parses the SSE
// response incrementally, calling back on each delta.
// =============================================================================

/**
 * Stream a chat completion from an OpenAI-compatible API.
 *
 * @param {object} opts
 * @param {string}   opts.baseUrl   - API base URL (e.g. "https://api.openai.com/v1")
 * @param {string}   opts.apiKey    - Bearer token / API key
 * @param {string}   opts.model     - Model name (e.g. "gpt-4o")
 * @param {Array}    opts.messages  - [{role, content}] message array
 * @param {Function} opts.onChunk   - Called with each text delta: (text: string) => void
 * @param {Function} opts.onDone    - Called when stream finishes: (fullText: string, usage: object | null) => void
 * @param {Function} opts.onError   - Called on error: (err: Error) => void
 * @param {number}   [opts.temperature] - Sampling temperature (0..2)
 * @param {number}   [opts.maxTokens]   - Max tokens for the response
 * @param {number}   [opts.timeoutMs]   - Request timeout in ms (default 60000)
 */
export async function streamChat({
  baseUrl,
  apiKey,
  model,
  messages,
  onChunk,
  onDone,
  onError,
  temperature,
  maxTokens,
  timeoutMs = 60_000,
}) {
  if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
    onError(new Error("streamChat: missing required parameters (baseUrl, apiKey, model, messages)"));
    return;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
  };
  if (typeof temperature === "number" && temperature >= 0 && temperature <= 2) {
    body.temperature = temperature;
  }
  if (typeof maxTokens === "number" && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`LLM API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    // The response body is an SSE stream. We read it as a ReadableStream
    // and parse each line. Lines starting with "data: " carry JSON payloads.
    // The stream terminates with "data: [DONE]".
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines. SSE lines are separated by \n (or \r\n).
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        if (trimmed === "data: [DONE]") {
          // Stream complete.
          onDone(fullText, usage);
          clearTimeout(timeout);
          return;
        }
        if (!trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6); // strip "data: " prefix
        try {
          const chunk = JSON.parse(jsonStr);
          // OpenAI SSE format: chunk.choices[0].delta.content
          const delta = chunk.choices?.[0]?.delta;
          if (delta && typeof delta.content === "string") {
            fullText += delta.content;
            onChunk(delta.content);
          }
          // Capture usage from the final chunk if present.
          if (chunk.usage) {
            usage = chunk.usage;
          }
        } catch {
          // Malformed JSON line — skip (could be a keepalive or log line).
        }
      }
    }

    // Stream ended without [DONE] — still call onDone with what we have.
    onDone(fullText, usage);
  } catch (err) {
    if (err.name === "AbortError") {
      onError(new Error(`LLM request timed out after ${timeoutMs}ms`));
    } else {
      onError(err);
    }
  } finally {
    clearTimeout(timeout);
  }
}
