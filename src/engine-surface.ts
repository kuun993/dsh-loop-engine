/**
 * Per-session command and skill surface of the hosted engines.
 *
 * A hosted engine owns its session's slash-command menu and skill catalog: the
 * engine expands `/name` itself and reads its own instruction files, so the
 * plugin bridges both into the session the engine serves and nothing more.
 *
 * The registrations are made through the AGENT's own context, which is what
 * makes them session-scoped: `commands.register` and
 * `skills.registerProvider` file a definition into the layer of the calling
 * context's scope (`packages/core/scope/src/store.ts` `effect()` keys the layer
 * by `scopeOf(ctx)`), and an agent's scope key is the agent itself
 * (`createScope(loopCtx, this)` in the default loop; the hosted drivers do the
 * same). Two sessions running different engines therefore never see each
 * other's menus, and the whole surface disappears with the agent's scope — no
 * plugin-side bookkeeping, no leak across an engine switch.
 *
 * @module dsh-loop-engine/engine-surface
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandsService, SkillsService } from './driver-core/host-servers.ts'
import type { CommandDefinition } from './commands.ts'
import { CLAUDE_CODE_COMMANDS, discoverUserSlashCommands } from './commands.ts'
import { KIMI_COMMANDS } from './engine-kimi/commands.ts'
import { ClaudeCodeSkillProvider } from './skills.ts'
import type { SkillProvider, SkillProviderControl } from './skills.ts'
import { CodexSkillProvider } from './engine-codex/skills.ts'
import { PiSkillProvider } from './engine-pi/skills.ts'
import { KimiSkillProvider } from './engine-kimi/skills.ts'
import type { HostedEngineId } from './settings.ts'

/** One engine's bridged surface: the commands and skill provider it contributes. */
interface EngineSurface {
  /** Slash commands to bridge, resolved at agent-creation time. */
  commands?(): readonly CommandDefinition[]
  /** Skill provider registered for the session, when the engine exposes one. */
  skills?(control: SkillProviderControl): SkillProvider
}

/**
 * The surface each hosted engine contributes. Commands are produced lazily
 * because the Claude Code bridge discovers the user's `~/.claude/commands/*.md`
 * on every call, so a file added mid-session lands on the next session the
 * engine builds.
 */
const SURFACES: Readonly<Record<HostedEngineId, EngineSurface>> = {
  'claude-code': {
    commands: () => [...CLAUDE_CODE_COMMANDS, ...discoverUserSlashCommands()],
    skills: control => new ClaudeCodeSkillProvider(control),
  },
  codex: {
    skills: control => new CodexSkillProvider(control),
  },
  pi: {
    skills: control => new PiSkillProvider(control),
  },
  kimi: {
    commands: () => KIMI_COMMANDS,
    skills: control => new KimiSkillProvider(control),
  },
}

/**
 * Bridge one hosted engine's commands and skills into the session it serves.
 *
 * Best-effort like the rest of the plugin's host-service use: a profile without
 * the commands or skills registry simply has no surface to extend. A name that
 * collides with an already-registered command in the same layer is skipped with
 * a warning rather than failing the agent: the engine expands the raw `/name`
 * line itself, so a shyer menu beats an agent that refuses to start.
 *
 * @param agent - the freshly built agent whose scope owns the registrations.
 * @param engine - the hosted engine driving that agent.
 * @param warn - sink for the skip diagnostics.
 */
export function registerEngineSurface(
  agent: Agent,
  engine: HostedEngineId,
  warn: (message: string) => void,
): void {
  const surface = SURFACES[engine]
  const commands = agent.ctx.get('commands') as CommandsService | undefined
  if (commands !== undefined && surface.commands !== undefined) {
    for (const command of surface.commands()) {
      try {
        commands.register(command)
      } catch (error: unknown) {
        warn(`loop-engine: skip ${engine} command /${command.name}: ${String(error)}`)
      }
    }
  }
  const skills = agent.ctx.get('skills') as SkillsService | undefined
  if (skills !== undefined && surface.skills !== undefined) {
    skills.registerProvider(surface.skills)
  }
}
