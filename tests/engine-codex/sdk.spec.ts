/**
 * Unit tests for the Codex SDK options assembly: thread options, the
 * credential-scrubbed environment overlay, and the CODEX_API_KEY injection.
 * @module tests/engine-codex/sdk
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  codexQueryOptions,
  codexThreadOptions,
  type CodexQuerySpec,
} from '../../src/engine-codex/sdk.ts'

function spec(overrides: Partial<CodexQuerySpec> = {}): CodexQuerySpec {
  return {
    cwd: process.cwd(),
    permission: { sandboxMode: 'read-only', approvalPolicy: 'never' },
    env: { DSH_TEST: '1' },
    ...overrides,
  }
}

describe('codexThreadOptions', () => {
  it('fixes the workspace, skips the git repo check, and carries the permission stance', () => {
    const options = codexThreadOptions(spec())
    expect(options.workingDirectory).toBe(process.cwd())
    expect(options.skipGitRepoCheck).toBe(true)
    expect(options.sandboxMode).toBe('read-only')
    expect(options.approvalPolicy).toBe('never')
    expect('model' in options).toBe(false)
    expect('networkAccessEnabled' in options).toBe(false)
  })

  it('carries the model and network pinning when the deployment sets them', () => {
    const options = codexThreadOptions(spec({
      permission: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      model: 'gpt-5.2-codex',
      networkAccessEnabled: true,
    }))
    expect(options.sandboxMode).toBe('workspace-write')
    expect(options.approvalPolicy).toBe('on-request')
    expect(options.model).toBe('gpt-5.2-codex')
    expect(options.networkAccessEnabled).toBe(true)
  })
})

describe('codexQueryOptions', () => {
  it('layers deployed entries over the scrubbed parent environment', () => {
    const options = codexQueryOptions(spec({ env: { EXTRA: 'yes' } }), new AbortController().signal)
    expect(options.codexOptions.env?.EXTRA).toBe('yes')
    expect('baseUrl' in options.codexOptions).toBe(false)
    expect(options.threadOptions.workingDirectory).toBe(process.cwd())
  })

  it('injects a pinned API key as CODEX_API_KEY and carries the base URL', () => {
    const options = codexQueryOptions(spec({
      apiKey: 'sk-test',
      baseUrl: 'https://codex.example.test/v1',
    }), new AbortController().signal)
    expect(options.codexOptions.env?.CODEX_API_KEY).toBe('sk-test')
    expect(options.codexOptions.baseUrl).toBe('https://codex.example.test/v1')
  })

  it('omits CODEX_API_KEY when no key is pinned', () => {
    const options = codexQueryOptions(spec(), new AbortController().signal)
    expect(options.codexOptions.env?.CODEX_API_KEY).toBeUndefined()
  })

  it('forwards the per-query cancellation signal', () => {
    const signal = new AbortController().signal
    expect(codexQueryOptions(spec(), signal).signal).toBe(signal)
  })
})

describe('permission-mode defaults', () => {
  it('exposes the shared dispose grace default', () => {
    expect(DEFAULT_DISPOSE_GRACE_MS).toBe(3000)
  })
})
