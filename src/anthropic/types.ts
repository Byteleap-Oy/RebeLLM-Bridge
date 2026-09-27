/**
 * The parts of the Anthropic Messages API the bridge reads and writes. Requests arrive as
 * unknown JSON and are checked in `map.ts`; these are the shapes it accepts and answers with.
 */

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** A search the bridge ran for the model, as Anthropic reports its own. */
export interface ServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: 'web_search'
  input: Record<string, unknown>
}

export interface WebSearchResult {
  type: 'web_search_result'
  url: string
  title: string
  encrypted_content: string
  page_age: string | null
}

export interface WebSearchError {
  type: 'web_search_tool_result_error'
  error_code: 'unavailable' | 'too_many_requests' | 'invalid_input' | 'query_too_long' | 'max_uses_exceeded'
}

export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: WebSearchResult[] | WebSearchError
}

export type ContentBlock = TextBlock | ToolUseBlock | ServerToolUseBlock | WebSearchToolResultBlock

/** Request content blocks the mapping looks into; any other type is degraded or dropped. */
export interface ToolResultBlockParam {
  type: 'tool_result'
  tool_use_id: string
  content?: string | { type: string; text?: string }[]
  is_error?: boolean
}

export interface MessageParam {
  role: 'user' | 'assistant' | 'system'
  content: string | ({ type: string } & Record<string, unknown>)[]
}

export interface ToolParam {
  type?: 'custom'
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

export interface MessagesRequest {
  model?: string
  system?: string | TextBlock[]
  messages: MessageParam[]
  tools?: ToolParam[]
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none' }
  max_tokens?: number
  temperature?: number
  stop_sequences?: string[]
  stream?: boolean
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  server_tool_use?: { web_search_requests: number }
}

export interface Message {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ContentBlock[]
  stop_reason: StopReason | null
  stop_sequence: string | null
  usage: Usage
}

/** Server-sent events of a streamed message, in the order the API sends them. */
export type StreamEvent =
  | { type: 'message_start'; message: Message }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | {
      type: 'content_block_delta'
      index: number
      delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason: StopReason; stop_sequence: string | null }
      usage: Omit<Usage, 'cache_creation_input_tokens' | 'cache_read_input_tokens'>
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: ApiError }

export type ErrorType =
  'invalid_request_error' | 'permission_error' | 'not_found_error' | 'request_too_large' | 'api_error'

export interface ApiError {
  type: ErrorType
  message: string
}

export interface ErrorBody {
  type: 'error'
  error: ApiError
}
