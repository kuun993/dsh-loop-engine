/**
 * Unit tests for the SDK-era constants retained by the codex driver.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_DISPOSE_GRACE_MS } from '../../src/engine-codex/sdk.ts'

describe('DEFAULT_DISPOSE_GRACE_MS', () => {
  it('exposes the shared dispose grace default', () => {
    expect(DEFAULT_DISPOSE_GRACE_MS).toBe(3000)
  })
})
