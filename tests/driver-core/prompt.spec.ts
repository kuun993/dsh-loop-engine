/**
 * Unit tests for the shared prompt builder: transcript serialization and the
 * engine slash-command path that bypasses it.
 *
 * @module tests/driver-core/prompt
 */

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, ToolCallId, type ContentBlock, type ImageAttachmentAccessResolver, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { engineSlashPrompt, OMITTED_IMAGE_TEXT, serializeHistory } from '../../src/driver-core/prompt.ts'
// Loads the `skill-invocation` MessageSourceMap arm this driver injects.
import type {} from '../../src/driver-core/skill-inject.ts'

/** One direct user message carrying `text`. */
function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One assistant message carrying `text`. */
function assistant(text: string): Message {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'kimi', model: 'default' } }) as Message
}

/**
 * One durable image block, named and dimensioned as the log records it.
 * @param name - the recorded display name; `null` records an image the log keeps unnamed.
 * @returns the content block as a message in the log holds it.
 */
function imageBlock(name: string | null = 'shot.png'): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId('img-1'),
      mediaType: 'image/png',
      bytes: 1234,
      width: 800,
      height: 600,
      ...(name === null ? {} : { name }),
    },
  }
}

/** A direct user message carrying `blocks`. */
function userWith(blocks: ContentBlock[]): UserMessage {
  return createUserMessage({ content: blocks, source: { kind: 'user' } })
}

/** A resolver that answers one fixed read-only path for every reference. */
const resolving = (readonlyPath: string): ImageAttachmentAccessResolver => () => ({ readonlyPath })

describe('engineSlashPrompt', () => {
  it('returns undefined for an empty history', () => {
    expect(engineSlashPrompt([])).toBeUndefined()
  })

  it('returns undefined when the live request is not a user message', () => {
    expect(engineSlashPrompt([user('hi'), assistant('hello')])).toBeUndefined()
  })

  it('returns undefined for a tool result as the last message', () => {
    const result = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: '/status' }],
      isError: false,
    })
    expect(engineSlashPrompt([user('run it'), result])).toBeUndefined()
  })

  it('returns undefined when injected skill content displaced the command line', () => {
    const injected = createUserMessage({
      content: [{ type: 'text', text: '<skill_content name="status">…</skill_content>' }],
      source: { kind: 'skill-invocation', name: 'status', form: 'instructions' },
    })
    expect(engineSlashPrompt([user('/status'), injected])).toBeUndefined()
  })

  it('returns undefined for a multi-block message', () => {
    const withImage = createUserMessage({
      content: [{ type: 'text', text: '/status' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }],
      source: { kind: 'user' },
    })
    expect(engineSlashPrompt([withImage])).toBeUndefined()
  })

  it('returns undefined when the only block is not text', () => {
    const imageOnly = createUserMessage({
      content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
      source: { kind: 'user' },
    })
    expect(engineSlashPrompt([imageOnly])).toBeUndefined()
  })

  it('returns undefined for a multi-line message that merely opens with a slash', () => {
    expect(engineSlashPrompt([user('/status\nand then some prose')])).toBeUndefined()
  })

  it('returns undefined for path-like and command-less leads', () => {
    for (const text of ['/', '/etc/hosts is unreadable', '//server/share', '/tmp/x text', 'no slash at all']) {
      expect(engineSlashPrompt([user(text)]), text).toBeUndefined()
    }
  })

  it('returns the raw command line, ignoring the replayed history', () => {
    expect(engineSlashPrompt([user('hi'), assistant('hello'), user('/status')])).toBe('/status')
    expect(engineSlashPrompt([user('/status --json  ')])).toBe('/status --json  ')
    expect(engineSlashPrompt([user('/skill:drawio a diagram')])).toBe('/skill:drawio a diagram')
  })
})

describe('serializeHistory', () => {
  it('frames every replayed message with its role label', () => {
    const result = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    expect(serializeHistory([user('hi'), assistant('hello'), result])).toBe([
      '<user>\nhi\n</user>',
      '<assistant>\nhello\n</assistant>',
      '<tool-result>\nok\n</tool-result>',
    ].join('\n\n'))
  })

  // The transcript cannot hand an engine image bytes, so an image block renders
  // as a placeholder naming the image the log carries. With the attachment
  // service composed, that placeholder also names the read-only path of the
  // normalized file, which is the only way the model can look at it.
  it('names the image and the read-only path the attachment service resolved', () => {
    const prompt = serializeHistory([userWith([imageBlock()])], resolving('/tmp/attachments/x.png'))
    expect(prompt).toBe(
      `<user>\n[image "shot.png" (image/png, 800x600px, 1234 bytes) omitted: ${OMITTED_IMAGE_TEXT}; read "/tmp/attachments/x.png" to view it]\n</user>`,
    )
  })

  it('falls back to the name "image" when the reference records none', () => {
    const prompt = serializeHistory(
      [userWith([imageBlock(null)])],
      resolving('/tmp/attachments/x.png'),
    )
    expect(prompt).toContain('image "image" (image/png, 800x600px, 1234 bytes)')
  })

  it('asks the user to attach the image again when no resolver was supplied', () => {
    const prompt = serializeHistory([userWith([imageBlock()])])
    expect(prompt).toBe(
      `<user>\n[image "shot.png" (image/png, 800x600px, 1234 bytes) omitted: ${OMITTED_IMAGE_TEXT}; no readable path is available — ask the user to attach the image again if it is needed]\n</user>`,
    )
  })

  it('renders the no-path form when the resolver answers undefined', () => {
    const prompt = serializeHistory([userWith([imageBlock()])], () => undefined)
    expect(prompt).toContain(OMITTED_IMAGE_TEXT)
    expect(prompt).toContain('no readable path is available')
    expect(prompt).not.toContain('to view it')
  })

  it('renders an assistant image block through the same placeholder', () => {
    const message = createAssistantMessage({
      content: [imageBlock(), { type: 'text', text: 'visible text' }],
      source: { provider: 'kimi', model: 'default' },
    }) as Message
    const prompt = serializeHistory([message], resolving('/tmp/attachments/x.png'))
    expect(prompt).toContain('read "/tmp/attachments/x.png" to view it')
    expect(prompt).toContain('visible text')
  })

  it('renders an image inside a 0.1.7 tool result through the same placeholder', () => {
    const result = createToolResultMessage({
      callId: ToolCallId('call-image'),
      content: [imageBlock()],
      isError: false,
    })
    const prompt = serializeHistory([result], resolving('/tmp/attachments/x.png'))
    expect(prompt).toBe(
      `<tool-result>\n[image "shot.png" (image/png, 800x600px, 1234 bytes) omitted: ${OMITTED_IMAGE_TEXT}; read "/tmp/attachments/x.png" to view it]\n</tool-result>`,
    )
  })

  // The 0.1.5 line carries a tool result on a user-role message whose single
  // `tool-result` block nests the result blocks; the introspector reads that
  // shape structurally, so these cases hold under either generation's message
  // union and guard the shared transcript text.
  it('renders a 0.1.5 user-role tool result as the same transcript section', () => {
    const legacyResult = {
      id: 'legacy-1',
      role: 'user',
      source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], isError: false }],
    } as unknown as Message
    expect(serializeHistory([legacyResult])).toBe('<tool-result>\nok\n</tool-result>')
  })

  it('renders a failed 0.1.5 tool result with its nested image omitted', () => {
    const legacyResult = {
      id: 'legacy-2',
      role: 'user',
      source: { kind: 'tool', callId: 'call-2' },
      content: [{ type: 'tool-result', toolCallId: 'call-2', content: [imageBlock()], isError: true }],
    } as unknown as Message
    expect(serializeHistory([legacyResult])).toBe(
      `<tool-result-error>\n[image "shot.png" (image/png, 800x600px, 1234 bytes) omitted: ${OMITTED_IMAGE_TEXT}; no readable path is available — ask the user to attach the image again if it is needed]\n</tool-result-error>`,
    )
  })

  it('renders an empty 0.1.5 tool result as (no content)', () => {
    const legacyResult = {
      id: 'legacy-3',
      role: 'user',
      source: { kind: 'tool', callId: 'call-3' },
      content: [{ type: 'tool-result', toolCallId: 'call-3', content: [], isError: false }],
    } as unknown as Message
    expect(serializeHistory([legacyResult])).toBe('<tool-result>\n(no content)\n</tool-result>')
  })

  it('tolerates a 0.1.5 tool-result message carrying no block', () => {
    const legacyResult = {
      id: 'legacy-4',
      role: 'user',
      source: { kind: 'tool', callId: 'call-4' },
      content: [],
    } as unknown as Message
    expect(serializeHistory([legacyResult])).toBe('<tool-result>\n(no content)\n</tool-result>')
  })
})
