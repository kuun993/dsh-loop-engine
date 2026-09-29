/**
 * The images one STEP hands to an engine that has a native image channel.
 *
 * The durable log is the model context, and a serialized prompt can only carry
 * an image as placeholder text naming the file ({@link serializeHistory}). An
 * engine whose protocol accepts image bytes should not be told to read the file
 * itself: {@link stepImages} resolves each image block of the step's own
 * messages through the attachment service's host path, reads that normalized
 * file, and returns it base64-encoded under the block's own media type. An
 * engine whose protocol takes the file's PATH instead shares the walk and the
 * resolution but reads nothing ({@link stepImagePaths}) — codex's app-server
 * opens the image itself.
 *
 * Only the messages this step delivers are claimed — a long session must not
 * re-upload its whole history every step. Older images stay in the transcript
 * as path-bearing placeholders, which the engine's own file tool can still read.
 *
 * @module dsh-loop-engine/driver-core/step-images
 */

import { readFile } from 'node:fs/promises'
import type { ContentBlock, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'

/** The durable reference an image block carries, derived from the block union so this module states no dependency on the attachment package. */
type ImageBlock = Extract<ContentBlock, { type: 'image' }>

/** One image block of a step, paired with the readable host path its attachment resolved to. */
interface ResolvedImage {
  /** The block itself, whose reference carries the media type. */
  readonly block: ImageBlock
  /** The read-only host path of the normalized file. */
  readonly path: string
}

/**
 * The media types a durable image reference can carry, taken from the block
 * union so this module names no attachment-package symbol. It is the exact set
 * every byte-accepting engine protocol declares (Anthropic's base64 image
 * source among them), so a caller may hand this value straight to one.
 */
type ImageMediaType = ImageBlock['attachment']['mediaType']

/** One image of a step, as an engine that accepts image bytes takes it. */
export interface StepImage {
  /** Base64-encoded normalized bytes. */
  readonly data: string
  /** The image's own media type, from the durable reference. */
  readonly mimeType: ImageMediaType
}

/**
 * Walk a step's messages and pair every image block whose attachment resolves
 * to a readable host path with that path, in message order. The one home of the
 * block-walking and resolution rule, so the byte channel and the path channel
 * cannot drift.
 *
 * An image whose path does not resolve is dropped here, not raised: the
 * transcript already names its path, and one unresolvable image must not fail a
 * step.
 * @param messages - the messages this step delivers, oldest first.
 * @param imageAccess - resolves an image block's read-only host path, when the host composes the attachment service.
 * @returns one entry per shipped image, empty when there are none.
 */
function resolvedImages(
  messages: readonly Message[],
  imageAccess?: ImageAttachmentAccessResolver,
): readonly ResolvedImage[] {
  const resolved: ResolvedImage[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      const path = imageAccess?.(block.attachment)?.readonlyPath
      if (path === undefined) continue
      resolved.push({ block, path })
    }
  }
  return resolved
}

/**
 * Collect the images a step's messages carry, in message order.
 *
 * An image whose path does not resolve, or whose file cannot be read, is
 * skipped: the transcript already names its path, so the model still has a route
 * to it, and one missing file must not fail a step.
 * @param messages - the messages this step delivers, oldest first.
 * @param imageAccess - resolves an image block's read-only host path, when the host composes the attachment service.
 * @returns the images to send, empty when there are none.
 */
export async function stepImages(
  messages: readonly Message[],
  imageAccess?: ImageAttachmentAccessResolver,
): Promise<readonly StepImage[]> {
  const images: StepImage[] = []
  for (const { block, path } of resolvedImages(messages, imageAccess)) {
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch {
      continue
    }
    images.push({ data: bytes.toString('base64'), mimeType: block.attachment.mediaType })
  }
  return images
}

/**
 * The readable host path of each image the step delivers, in order.
 *
 * Nothing is opened: an engine that takes a path reads the file itself, so a
 * path is returned even when no file is there — whether the path is usable is
 * the engine's answer, not this walk's.
 * @param messages - the messages this step delivers, oldest first.
 * @param imageAccess - resolves an image block's read-only host path, when the host composes the attachment service.
 * @returns the paths to send, empty when there are none.
 */
export function stepImagePaths(
  messages: readonly Message[],
  imageAccess?: ImageAttachmentAccessResolver,
): readonly string[] {
  return resolvedImages(messages, imageAccess).map(image => image.path)
}
