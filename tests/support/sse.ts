/** Test transport helpers: runStage streams, so fake providers must answer with Server-Sent Events. */
type Block = { type: string; [key: string]: unknown };
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`;

/** SSE frames that replay a complete Messages API body as a stream. `failAfter` appends a provider `error` event instead of finishing. */
export function messageEvents(message: { content: Block[]; stop_reason?: string | null; usage?: { input_tokens: number; output_tokens: number } },
  failAfter?: { type: string; message: string }): string {
  const usage = message.usage ?? { input_tokens: 0, output_tokens: 0 };
  let out = frame("message_start", { message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  message.content.forEach((block, index) => {
    const delta = block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : block.type === "thinking" ? { type: "thinking_delta", thinking: block.thinking } : { type: "text_delta", text: block.text };
    const start = block.type === "tool_use" ? { ...block, input: {} } : block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" };
    out += frame("content_block_start", { index, content_block: start }) + frame("content_block_delta", { index, delta });
    if (block.type === "thinking") out += frame("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature ?? "sig" } });
    if (failAfter && index === 0) { out += frame("error", { error: failAfter }); return; }
    out += frame("content_block_stop", { index });
  });
  if (failAfter) return out;
  return out + frame("message_delta", { delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }) + frame("message_stop", {});
}

export const sseResponse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/event-stream" } });

/** Re-encode a 200 JSON Messages response as a stream; any other response (errors, non-messages) passes through unchanged. */
export async function asStream(response: Response | Promise<Response>): Promise<Response> {
  const res = await response;
  if (res.status !== 200 || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = await res.clone().json() as { type?: string; content?: Block[] };
  return body.type === "message" && Array.isArray(body.content) ? sseResponse(messageEvents(body as Parameters<typeof messageEvents>[0])) : res;
}
