/**
 * Unit tests for the shared image-access resolver: the attachment service is
 * read on every call, perceived structurally, and each way it can come up empty
 * — no service, no host-path method, or no path for this reference — answers
 * "no readable path" rather than throwing.
 *
 * @module tests/driver-core/image-access
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createImageAccessResolver } from '../../src/driver-core/image-access.ts'

/** One durable normalized image reference, as a message in the log carries it. */
const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('img-1'),
  mediaType: 'image/png',
  bytes: 1234,
  width: 800,
  height: 600,
  name: 'shot.png',
}

/**
 * A context composing the attachment service only when the case supplies one.
 * @param service - the attachment service stand-in, or `undefined` for a host that composes none.
 * @returns the context to build a resolver on.
 */
function mount(service?: unknown): Context {
  const ctx = new Context()
  if (service !== undefined) ctx.provide('attachments', service)
  return ctx
}

describe('createImageAccessResolver', () => {
  it('answers undefined when the host composes no attachment service', () => {
    expect(createImageAccessResolver(mount())(REF)).toBeUndefined()
  })

  it('answers undefined when the service exposes no host-path method', () => {
    const resolve = createImageAccessResolver(mount({ saveImage: vi.fn() }))
    expect(resolve(REF)).toBeUndefined()
  })

  it('answers the read-only path the service reports for this reference', () => {
    const imageHostPath = vi.fn((_ref: ImageAttachmentRef) => '/tmp/normalized/x.png')
    const resolve = createImageAccessResolver(mount({ imageHostPath }))
    expect(resolve(REF)).toEqual({ readonlyPath: '/tmp/normalized/x.png' })
    expect(imageHostPath).toHaveBeenCalledWith(REF)
  })

  it('answers undefined when the service reports no path for this reference', () => {
    const resolve = createImageAccessResolver(mount({ imageHostPath: () => undefined }))
    expect(resolve(REF)).toBeUndefined()
  })

  it('reads the service on every call, so a service mounted later is still seen', () => {
    const ctx = mount()
    const resolve = createImageAccessResolver(ctx)
    expect(resolve(REF)).toBeUndefined()
    ctx.provide('attachments', { imageHostPath: () => '/tmp/late.png' })
    expect(resolve(REF)).toEqual({ readonlyPath: '/tmp/late.png' })
  })
})
