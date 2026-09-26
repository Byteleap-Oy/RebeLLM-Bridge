import type { ServerResponse } from 'node:http'
import type { ApiError, Message, StopReason, StreamEvent, ToolUseBlock, Usage } from './types.js'

/**
 * Writes one streamed message as the Messages API does: `message_start`, the content blocks
 * (a text block opened by the first text, one block per tool call), `message_delta`,
 * `message_stop`.
 */
export class EventWriter {
  private readonly res: ServerResponse
  private blocks = 0
  private textOpen = false

  constructor(res: ServerResponse) {
    this.res = res
  }

  private send(e: StreamEvent) {
    this.res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  }

  start(message: Message) {
    this.send({ type: 'message_start', message })
  }

  text(text: string) {
    if (!text) return
    if (!this.textOpen) {
      this.send({ type: 'content_block_start', index: this.blocks, content_block: { type: 'text', text: '' } })
      this.textOpen = true
    }
    this.send({ type: 'content_block_delta', index: this.blocks, delta: { type: 'text_delta', text } })
  }

  toolUse(block: ToolUseBlock) {
    this.closeText()
    const index = this.blocks++
    this.send({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
    const partial_json = JSON.stringify(block.input)
    this.send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
    this.send({ type: 'content_block_stop', index })
  }

  /** Ends the message; an answer with no content still gets one empty text block. */
  finish(reason: StopReason, sequence: string | null, usage: Usage) {
    if (!this.blocks && !this.textOpen) {
      this.send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      this.textOpen = true
    }
    this.closeText()
    this.send({
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: sequence },
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    })
    this.send({ type: 'message_stop' })
    this.res.end()
  }

  /** Keeps clients' read timeouts from cutting a slow first token. */
  ping() {
    this.send({ type: 'ping' })
  }

  /** Ends the stream with an error; Anthropic's SDKs raise it as an API error. */
  error(error: ApiError) {
    this.send({ type: 'error', error })
    this.res.end()
  }

  private closeText() {
    if (!this.textOpen) return
    this.send({ type: 'content_block_stop', index: this.blocks++ })
    this.textOpen = false
  }
}
