/**
 * Unit tests for the step's image bytes: every image block of the messages a
 * step delivers is resolved through the attachment service's read-only path,
 * read from disk, and handed on base64-encoded under the block's own media
 * type. Everything that can go wrong for one image — no resolver, no path, an
 * unreadable file — drops that image alone rather than failing the step.
 *
 * @module tests/driver-core/step-images
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { stepImages } from '../../src/driver-core/step-images.ts'

/** Directories created by the case; removed after it. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A fresh temp directory whose lifetime this spec owns.
 * @returns the directory path.
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-step-images-'))
  tempDirs.push(dir)
  return dir
}

/**
 * Write a file of real bytes into a temp directory.
 * @param name - file name, and the extension a caller may key a path lookup on.
 * @param bytes - the file's bytes.
 * @returns the absolute path written.
 */
async function tempFile(name: string, bytes: Buffer): Promise<string> {
  const path = join(await tempDir(), name)
  await writeFile(path, bytes)
  return path
}

/**
 * One durable image reference, as a message in the log carries it.
 * @param name - display name; also this spec's key for the fake lookup.
 * @param mediaType - the image's media type.
 * @returns the reference.
 */
function ref(name: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): ImageAttachmentRef {
  return { attachmentId: AttachmentId(`img-${name}`), mediaType, bytes: 4, width: 2, height: 2, name }
}

/**
 * A user message carrying the given image references as its image blocks.
 * @param refs - one block per reference.
 * @returns the message.
 */
function imageMessage(...refs: readonly ImageAttachmentRef[]): Message {
  return createUserMessage({
    content: [{ type: 'text', text: 'look' }, ...refs.map(attachment => ({ type: 'image' as const, attachment }))],
    source: { kind: 'user' },
  })
}

/** A user message carrying no image at all. */
const TEXT_MESSAGE: Message = createUserMessage({
  content: [{ type: 'text', text: 'no pictures here' }],
  source: { kind: 'user' },
})

describe('stepImages', () => {
  it('returns an empty list when no message carries an image', async () => {
    expect(await stepImages([TEXT_MESSAGE])).toEqual([])
  })

  it('returns an empty list when the host composes no resolver', async () => {
    expect(await stepImages([imageMessage(ref('a.png'))])).toEqual([])
  })

  it('reads every image of several messages, in order, under its own media type', async () => {
    const first = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const second = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const paths: Record<string, string> = {
      'a.png': await tempFile('a.png', first),
      'b.jpg': await tempFile('b.jpg', second),
    }
    const messages = [imageMessage(ref('a.png')), imageMessage(ref('b.jpg', 'image/jpeg'))]

    const images = await stepImages(messages, r => {
      const path = paths[r.name ?? '']
      return path === undefined ? undefined : { readonlyPath: path }
    })

    expect(images.map(image => image.mimeType)).toEqual(['image/png', 'image/jpeg'])
    expect(Buffer.from(images[0]?.data ?? '', 'base64')).toEqual(first)
    expect(Buffer.from(images[1]?.data ?? '', 'base64')).toEqual(second)
    // Real base64, not the raw bytes re-encoded as text.
    expect(images[0]?.data).toBe(first.toString('base64'))
  })

  it('collects several image blocks of one message', async () => {
    const first = Buffer.from([1, 2, 3])
    const second = Buffer.from([4, 5, 6])
    const paths: Record<string, string> = {
      'a.png': await tempFile('a.png', first),
      'b.png': await tempFile('b.png', second),
    }

    const images = await stepImages([imageMessage(ref('a.png'), ref('b.png'))], r => ({
      readonlyPath: paths[r.name ?? ''] ?? '',
    }))

    expect(images.map(image => Buffer.from(image.data, 'base64'))).toEqual([first, second])
  })

  it('skips an image whose path does not resolve while its siblings still ship', async () => {
    const shipped = Buffer.from([9, 8, 7])
    const path = await tempFile('keep.png', shipped)

    const images = await stepImages([imageMessage(ref('gone.png'), ref('keep.png'))], r =>
      r.name === 'keep.png' ? { readonlyPath: path } : undefined)

    expect(images).toHaveLength(1)
    expect(Buffer.from(images[0]?.data ?? '', 'base64')).toEqual(shipped)
  })

  it('skips an image whose file cannot be read', async () => {
    const shipped = Buffer.from([3, 1, 4])
    const missing = join(await tempDir(), 'never-written.png')
    const present = await tempFile('present.png', shipped)

    const images = await stepImages([imageMessage(ref('missing.png'), ref('present.png'))], r =>
      r.name === 'present.png' ? { readonlyPath: present } : { readonlyPath: missing })

    expect(images).toHaveLength(1)
    expect(Buffer.from(images[0]?.data ?? '', 'base64')).toEqual(shipped)
  })
})
