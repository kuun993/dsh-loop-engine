/**
 * Unit tests for AppServerThread: thread creation, turn streaming, abort
 * handling, and event filtering by thread/turn.
 */

import { describe, expect, it, vi } from 'vitest'
import type { AppServerClient } from '../../../src/engine-codex/appserver/client.ts'
import { AppServerThread, type AppServerEvent } from '../../../src/engine-codex/appserver/thread.ts'

/** Create a fake client with the given threadStart/turnStart results. */
function fakeClient(overrides: Record<string, unknown> = {}): AppServerClient {
  return {
    threadStart: vi.fn(async () => ({ thread: { id: 'thread-1' } })),
    threadResume: vi.fn(async () => ({ thread: { id: 'thread-1' } })),
    turnStart: vi.fn(async () => ({ turn: { id: 'turn-1', status: 'inProgress' } })),
    turnInterrupt: vi.fn(async () => ({})),
    onNotification: vi.fn(),
    onStderr: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as AppServerClient
}

describe('AppServerThread.create', () => {
  it('creates a thread via the client', async () => {
    const client = fakeClient()
    const thread = await AppServerThread.create(client, { cwd: '/tmp' })
    expect(thread.threadId).toBe('thread-1')
    expect(client.threadStart).toHaveBeenCalledWith({ cwd: '/tmp' })
  })
})

describe('AppServerThread.turn', () => {
  it('streams events from notifications', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    // Collect events in background
    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    // Wait for the turn to be set up
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    // Simulate notifications from the server
    notificationHandler?.('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1' }, startedAtMs: 0 })
    notificationHandler?.('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'hello' })
    notificationHandler?.('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'hello' }, completedAtMs: 0 })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [], usage: { inputTokens: 1, outputTokens: 2 } } })

    await collect

    expect(events).toContainEqual({ kind: 'turn-started', turnId: 'turn-1' })
    expect(events).toContainEqual({ kind: 'item-started', itemType: 'agentMessage', itemId: 'msg-1' })
    expect(events).toContainEqual({ kind: 'agent-delta', itemId: 'msg-1', delta: 'hello' })
    expect(events).toContainEqual({ kind: 'item-completed', item: { type: 'agentMessage', id: 'msg-1', text: 'hello' } })
    expect(events).toContainEqual({ kind: 'turn-completed', turn: { id: 'turn-1', status: 'completed', error: null, items: [], usage: { inputTokens: 1, outputTokens: 2 } } })
  })

  it('captures notifications emitted before turn/start responds', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
      turnStart: vi.fn(async () => {
        notificationHandler?.('item/agentMessage/delta', {
          threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'early',
        })
        return { turn: { id: 'turn-1', status: 'inProgress' } }
      }),
    })
    const thread = await AppServerThread.create(client, {})
    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) events.push(event)
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    notificationHandler?.('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
    })
    await collect

    expect(events).toContainEqual({ kind: 'agent-delta', itemId: 'msg-1', delta: 'early' })
  })

  it('clears the notification handler when turn/start fails', async () => {
    const onNotification = vi.fn()
    const client = fakeClient({
      onNotification,
      turnStart: vi.fn(async () => { throw new Error('start failed') }),
    })
    const thread = await AppServerThread.create(client, {})

    await expect(async () => {
      for await (const _event of thread.turn([{ type: 'text', text: 'hi' }], {})) { /* empty */ }
    }).rejects.toThrow('start failed')
    expect(onNotification).toHaveBeenLastCalledWith(expect.any(Function))
    expect(onNotification).toHaveBeenCalledTimes(2)
  })

  it('filters notifications for other threads', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })

    // Send notifications for a different thread — should be ignored
    notificationHandler?.('item/agentMessage/delta', { threadId: 'other-thread', turnId: 'turn-1', itemId: 'msg-1', delta: 'ignored' })
    // Send turn/completed for our thread
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect

    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'agent-delta' }))
  })

  it('filters notifications for other turns', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })

    // Send notifications for a different turn — should be ignored
    notificationHandler?.('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'other-turn', itemId: 'msg-1', delta: 'ignored' })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect

    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'agent-delta' }))
  })

  it('throws on error notification', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const collect = (async () => {
      const events: AppServerEvent[] = []
      try {
        for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
          events.push(event)
        }
      } catch (error) {
        return { events, error }
      }
      return { events }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    notificationHandler?.('error', { threadId: 'thread-1', turnId: 'turn-1', error: { message: 'model overloaded' }, willRetry: false })

    const result = await collect
    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toBe('model overloaded')
  })

  it('aborts the turn via the signal', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const controller = new AbortController()
    const collect = (async () => {
      const events: AppServerEvent[] = []
      try {
        for await (const event of thread.turn([{ type: 'text', text: 'hi' }], { signal: controller.signal })) {
          events.push(event)
        }
      } catch (error) {
        return { events, error }
      }
      return { events }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    controller.abort(new Error('user cancelled'))

    const result = await collect
    expect(result.error).toBeInstanceOf(Error)
    expect(client.turnInterrupt).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-1' })
  })

  it('streams reasoning summary delta events', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    notificationHandler?.('item/reasoning/summaryTextDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r-1', delta: 'thinking', summaryIndex: 0 })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect
    expect(events).toContainEqual({ kind: 'reasoning-summary-delta', itemId: 'r-1', delta: 'thinking', summaryIndex: 0 })
  })

  it('streams reasoning text delta events', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    notificationHandler?.('item/reasoning/textDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r-1', delta: 'detailed', contentIndex: 0 })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect
    expect(events).toContainEqual({ kind: 'reasoning-text-delta', itemId: 'r-1', delta: 'detailed', contentIndex: 0 })
  })

  it('streams plan delta events', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    notificationHandler?.('item/plan/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'p-1', delta: 'plan step' })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect
    expect(events).toContainEqual({ kind: 'plan-delta', itemId: 'p-1', delta: 'plan step' })
  })

  it('streams token usage events', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    const usage = {
      total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5 },
      last: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 2 },
    }
    notificationHandler?.('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: usage })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect
    expect(events).toContainEqual({ kind: 'token-usage', usage })
  })

  it('ignores notifications after the turn is done', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })
    // Send another notification after done — should be ignored
    notificationHandler?.('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'late' })

    await collect
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'agent-delta' }))
  })

  it('streams item-started events', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    notificationHandler?.('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1' }, startedAtMs: 0 })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect
    expect(events).toContainEqual({ kind: 'item-started', itemType: 'agentMessage', itemId: 'msg-1' })
  })

  it('filters all notification types for other turns', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })

    // Send notifications for a different turn — all should be ignored
    const wrongTurn = 'other-turn'
    notificationHandler?.('item/started', { threadId: 'thread-1', turnId: wrongTurn, item: { type: 'agentMessage', id: 'msg-1' }, startedAtMs: 0 })
    notificationHandler?.('item/agentMessage/delta', { threadId: 'thread-1', turnId: wrongTurn, itemId: 'msg-1', delta: 'ignored' })
    notificationHandler?.('item/reasoning/summaryTextDelta', { threadId: 'thread-1', turnId: wrongTurn, itemId: 'r-1', delta: 'ignored', summaryIndex: 0 })
    notificationHandler?.('item/reasoning/textDelta', { threadId: 'thread-1', turnId: wrongTurn, itemId: 'r-1', delta: 'ignored', contentIndex: 0 })
    notificationHandler?.('item/plan/delta', { threadId: 'thread-1', turnId: wrongTurn, itemId: 'p-1', delta: 'ignored' })
    notificationHandler?.('item/completed', { threadId: 'thread-1', turnId: wrongTurn, item: { type: 'agentMessage', id: 'msg-1', text: 'ignored' }, completedAtMs: 0 })
    notificationHandler?.('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: wrongTurn, tokenUsage: { total: {}, last: {} } })
    notificationHandler?.('error', { threadId: 'thread-1', turnId: wrongTurn, error: { message: 'ignored' }, willRetry: false })

    // Send turn/completed for our thread
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect

    // Only turn-started and turn-completed should be present
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'turn-started' })
    expect(events[1]).toMatchObject({ kind: 'turn-completed' })
  })

  it('ignores turn/completed for a different thread', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    // Send turn/completed for a different thread — should be ignored
    notificationHandler?.('turn/completed', { threadId: 'other-thread', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })
    // Send turn/completed for our thread
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect

    const turnCompletedEvents = events.filter(e => e.kind === 'turn-completed')
    expect(turnCompletedEvents).toHaveLength(1)
  })

  it('streams reasoning summary delta, text delta, plan delta, item completed, and token usage', async () => {
    let notificationHandler: ((method: string, params: unknown) => void) | undefined
    const client = fakeClient({
      onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
        notificationHandler = handler
      }),
    })
    const thread = await AppServerThread.create(client, {})

    const events: AppServerEvent[] = []
    const collect = (async () => {
      for await (const event of thread.turn([{ type: 'text', text: 'hi' }], {})) {
        events.push(event)
      }
    })()

    await new Promise<void>((resolve) => { setImmediate(resolve) })

    // Send all notification types for our turn
    notificationHandler?.('item/reasoning/summaryTextDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r-1', delta: 'summary', summaryIndex: 0 })
    notificationHandler?.('item/reasoning/textDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r-1', delta: 'text', contentIndex: 0 })
    notificationHandler?.('item/plan/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'p-1', delta: 'plan' })
    notificationHandler?.('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'done' }, completedAtMs: 0 })
    notificationHandler?.('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total: {}, last: {} } })
    notificationHandler?.('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })

    await collect

    expect(events).toContainEqual({ kind: 'reasoning-summary-delta', itemId: 'r-1', delta: 'summary', summaryIndex: 0 })
    expect(events).toContainEqual({ kind: 'reasoning-text-delta', itemId: 'r-1', delta: 'text', contentIndex: 0 })
    expect(events).toContainEqual({ kind: 'plan-delta', itemId: 'p-1', delta: 'plan' })
    expect(events).toContainEqual({ kind: 'item-completed', item: { type: 'agentMessage', id: 'msg-1', text: 'done' } })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'token-usage' }))
  })
})
