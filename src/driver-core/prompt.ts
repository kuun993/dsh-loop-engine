/**
 * Serialization of the durable session history into the prompt text of one
 * hosted-engine query. Every hosted driver builds its
 * per-step input from the durable session log: the transcript is the log's
 * exact projection, so a later replay of the same log derives the identical
 * prompt (Model-visible ⟺ logged bridge).
 *
 * A step whose live request is an engine slash command is the one exception to
 * the transcript framing: {@link engineSlashPrompt} sends that command line
 * verbatim, because the engines only recognize their own commands at the head
 * of the prompt. It is still derived from the log alone, so the guarantee
 * holds.
 *
 * @module dsh-loop-engine/driver-core/prompt
 */

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

/** Model-facing stand-in for an image block that the hosted engines cannot consume as bytes. */
export const OMITTED_IMAGE_TEXT
  = '[image omitted: the driver does not transcribe images; read the file when a path is available]'

/**
 * Frame a serialized message body with its visible role label.
 * @param tag - the role marker used in the transcript.
 * @param body - the rendered content of the message.
 * @returns the framed transcript section.
 */
function frame(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`
}

/**
 * Render one assistant message's content blocks to transcript text. Text
 * blocks render verbatim; tool-call blocks render as a compact invocation
 * line; reasoning content is not transcribed (each engine re-derives its own
 * thinking in every fresh query).
 * @param blocks - the assistant message's content blocks.
 * @returns the transcript text of the message body.
 */
function renderAssistantBlocks(blocks: readonly ContentBlock[]): string {
  const sections: unknown[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        sections.push(block.text)
        break
      case 'tool-call':
        sections.push(`[tool call: ${block.name}(${block.arguments})]`)
        break
      case 'image':
        sections.push(OMITTED_IMAGE_TEXT)
        break
      default:
        // reasoning and unknown blocks stay out of the transcript.
        break
    }
  }
  return sections.join('\n\n')
}

/**
 * Render one tool-result message to transcript text. The nested content
 * blocks render verbatim, marked as an error result when the call failed.
 * @param message - the durable tool-result message.
 * @returns the transcript text of the tool result.
 */
function renderToolResult(message: ToolResultMessage): string {
  const block = message.content[0]
  const body = block.content.map((child) => {
    switch (child.type) {
      case 'text':
        return child.text
      case 'image':
        return OMITTED_IMAGE_TEXT
      default:
        return ''
    }
  }).filter(section => section !== '').join('\n\n')
  const tag = block.isError === true ? 'tool-result-error' : 'tool-result'
  return frame(tag, body || '(no content)')
}

/**
 * An engine slash-command line: `/name` with an optional single-line argument
 * tail. The name may hold neither whitespace nor `/`, so a path-like lead
 * (`/etc/hosts`, `//server/share`) is never mistaken for a command.
 */
const ENGINE_SLASH_LINE = /^\/[^\s/]+(?:[ \t]+.*)?$/

/**
 * The engine's own slash-command line to send as this step's entire prompt, or
 * `undefined` when the step is an ordinary conversational step.
 *
 * Every hosted engine expands a slash command only when the text handed to it
 * *starts* with `/` — Kimi's ACP adapter parses the first prompt block, Claude
 * Code's local-command dispatch and Pi's input expansion both test the leading
 * character of the message string. The serialized transcript never satisfies
 * that (it opens with `<user>`), so a forwarded `/status` reaches the model as
 * prose instead of the engine's own command surface. This helper lets a driver
 * recognize the case and send the command line verbatim, with no transcript
 * framing and no replay history: a slash command is a control line for the
 * engine, not conversation for the model.
 *
 * The live request is the last derived message, so a step whose trailing
 * message is a bare command line is a command step. A trailing skill-injection
 * message (the `/name` skill gesture the drivers materialize as its own user
 * message) displaces it and keeps the step on the transcript path.
 *
 * The returned line is a pure function of the log prefix, so the step stays
 * replayable: the same log derives the same prompt.
 * @param messages - derived history, oldest first, as returned by
 *   `Session.deriveMessages()` at step time.
 * @returns the raw command line, or `undefined` for an ordinary step.
 */
export function engineSlashPrompt(messages: readonly Message[]): string | undefined {
  const last = messages.at(-1)
  if (last === undefined || last.role !== 'user') return undefined
  const user = last as UserMessage
  // Only a direct user message is a command line: a tool result or an injected
  // skill body is driver material, never something the user typed.
  if (user.source.kind !== 'user') return undefined
  // A command line is the whole message; a multi-block message carries
  // attachments (or is a multi-part prompt) and stays on the transcript path.
  if (user.content.length !== 1) return undefined
  const block = user.content[0]
  if (block?.type !== 'text') return undefined
  const text = block.text
  // The engines parse a single line: a newline makes the tail an argument of
  // nothing, and multi-line prose that merely opens with `/` is a user message.
  if (text.includes('\n')) return undefined
  return ENGINE_SLASH_LINE.test(text) ? text : undefined
}

/**
 * Serialize a derived conversation history into the prompt text of one hosted
 * query. The last message is the live user request that triggered the step;
 * every earlier message is durable replay context. The output is a pure
 * function of the log prefix.
 * @param messages - derived history, oldest first, as returned by
 *   `Session.deriveMessages()` at step time.
 * @returns the prompt text to pass to the engine.
 */
export function serializeHistory(messages: readonly Message[]): string {
  const sections: string[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'assistant': {
        const body = renderAssistantBlocks((message as AssistantMessage).content)
        if (body !== '') sections.push(frame('assistant', body))
        break
      }
      case 'user': {
        const user = message as UserMessage
        if (user.source.kind === 'tool') {
          sections.push(renderToolResult(user as ToolResultMessage))
        } else {
          const body = user.content.map((block) => {
            switch (block.type) {
              case 'text':
                return block.text
              case 'image':
                return OMITTED_IMAGE_TEXT
              default:
                return ''
            }
          }).filter(section => section !== '').join('\n\n')
          sections.push(frame('user', body || '(no content)'))
        }
        break
      }
      default:
        // system-role messages never reach the derived conversation surface.
        break
    }
  }
  return sections.join('\n\n')
}
