/**
 * The out-of-tree Remote contribution is declared STRUCTURALLY, so no compiler
 * sees the harness's own contract for it. One field drifted between the two
 * harness generations and silently kept the session Remote from mounting on
 * 0.1.7 — the composer sat on "reading" forever while the settings page (a
 * different path) worked. Pin the shape both generations' validators require.
 */

import { describe, expect, it } from 'vitest'
import { LOOP_ENGINE_REMOTE_CONTRIBUTION } from '../../src/client/session-engine.ts'

describe('the loop-engine Remote contribution', () => {
  it('declares a package identity', () => {
    expect(LOOP_ENGINE_REMOTE_CONTRIBUTION.package).toBe('dsh-loop-engine')
    expect(LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors.length).toBeGreaterThan(0)
  })

  for (const descriptor of LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors) {
    it(`${descriptor.id} carries codecs both harness generations accept`, () => {
      const codecs = [...descriptor.parameters.map(parameter => parameter.codec), descriptor.result]
      for (const codec of codecs) {
        expect(codec.mode).toBe('strict')
        expect(codec.typeSymbol.length).toBeGreaterThan(0)
        // The 0.1.5 line's registry/gateway parse through `schema` directly.
        expect(typeof codec.schema.parse).toBe('function')
        // The 0.1.7 line's registry REQUIRES `create()` and parses through
        // `codec.create()`; it ignores `schema`. Without this the contribution's
        // `$mount` is refused ("strict codec has no create() factory").
        expect(typeof codec.create).toBe('function')
        expect(typeof codec.create().parse).toBe('function')
      }
    })
  }
})
