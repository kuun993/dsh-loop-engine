/**
 * The image bytes one STEP hands to an engine that has a native image channel.
 *
 * The durable log is the model context, and a serialized prompt can only carry
 * an image as placeholder text naming the file ({@link serializeHistory}). An
 * engine whose protocol accepts image bytes should not be told to read the file
 * itself: {@link stepImages} resolves each image block of the step's own
 * messages through the attachment service's host path, reads that normalized
 * file, and returns it base64-encoded under the block's own media type.
 *
 * Only the messages this step delivers are claimed — a long session must not
 * re-upload its whole history every step. Older images stay in the transcript
 * as path-bearing placeholders, which the engine's own file tool can still read.
 *
 * @module dsh-loop-engine/driver-core/step-images
 */

import { readFile } from 'node:fs/promises'
import type { ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'

/** One image of a step, as an engine that accepts image bytes takes it. */
export interface StepImage {
  /** Base64-encoded normalized bytes. */
  readonly data: string
  /** The image's own media type, from the durable reference. */
  readonly mimeType: string
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
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      const path = imageAccess?.(block.attachment)?.readonlyPath
      if (path === undefined) continue
      let bytes: Buffer
      try {
        bytes = await readFile(path)
      } catch {
        continue
      }
      images.push({ data: bytes.toString('base64'), mimeType: block.attachment.mediaType })
    }
  }
  return images
}
