/**
 * Image access for the hosted transcript. A hosted engine takes one text
 * prompt, so the image blocks of the durable log reach it only as placeholder
 * text — but the host's attachment service owns the normalized bytes and can
 * name the read-only path they live at. This module turns that service into the
 * resolver the transcript renders placeholders with.
 *
 * @module dsh-loop-engine/driver-core/image-access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentAccessResolver } from '@deepseek-ai/dsh-llm'

/**
 * The durable image reference a resolver is asked about, taken from the
 * resolver contract itself so this module states no dependency on the
 * attachment package the reference belongs to.
 */
type ImageRef = Parameters<ImageAttachmentAccessResolver>[0]

/**
 * The attachment service as this plugin sees it: the single host-path method it
 * calls, declared structurally so an absent service is simply an absent object.
 */
interface AttachmentHostPaths {
  /**
   * Absolute host path of one normalized image.
   * @param ref - durable normalized attachment reference.
   * @returns the host path, or `undefined` when the backend is not host-file-backed.
   */
  imageHostPath?(ref: ImageRef): string | undefined
}

/**
 * Build the resolver a hosted agent hands to `serializeHistory`, so a
 * transcript can name the file behind each image the log carries.
 *
 * The service is read on every call — the pattern this plugin uses for every
 * optional host service — so a resolver built before the attachment service
 * mounts still answers once it has, and no path is ever cached across steps:
 * the transcript stays a pure function of the durable log.
 * @param ctx - the loop context whose host may compose the attachment service.
 * @returns a resolver answering `{ readonlyPath }`, or `undefined` when the service or the path is absent.
 */
export function createImageAccessResolver(ctx: Context): ImageAttachmentAccessResolver {
  return (ref) => {
    const attachments = ctx.get('attachments') as AttachmentHostPaths | undefined
    if (attachments?.imageHostPath === undefined) return undefined
    const readonlyPath = attachments.imageHostPath(ref)
    return readonlyPath === undefined ? undefined : { readonlyPath }
  }
}
