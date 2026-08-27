/**
 * Serialization of the durable session history into the prompt text of one
 * Claude Code query. The session log is the sole source of model context; the
 * serialized transcript is its exact projection, so a later replay of the same
 * log derives the identical prompt (Model-visible ⟺ logged bridge).
 *
 * @module @kuun993/dsh-loop-engine/engine-claude/prompt
 */

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

/** Model-facing stand-in for an image block that Claude Code cannot consume as bytes. */
export const OMITTED_IMAGE_TEXT
  = '[image omitted: the Claude Code driver does not transcribe images; read the file when a path is available]'

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
 * line; reasoning content is not transcribed (Claude Code re-derives its own
 * thinking in each fresh query).
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
 * Serialize a derived conversation history into the prompt text of one Claude
 * Code query. The last message is the live user request that triggered the
 * step; every earlier message is durable replay context. The output is a pure
 * function of the log prefix.
 * @param messages - derived history, oldest first, as returned by
 *   `Session.deriveMessages()` at step time.
 * @returns the prompt text to pass to the Claude Agent SDK.
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
