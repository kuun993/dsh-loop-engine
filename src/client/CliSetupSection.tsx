/** Settings cards for installing and validating the three official CLIs. */

import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CliId } from '../cli-setup.ts'
import type { CliSetupClient, CliSetupSnapshot } from './cli-setup.ts'
import type { en } from './locales.ts'

export interface CliSetupSectionProps {
  readonly client: CliSetupClient
  readonly t: (key: keyof typeof en) => string
}

const cards: readonly { cli: CliId; nameKey: keyof typeof en; loginKey: keyof typeof en }[] = [
  { cli: 'claude', nameKey: 'cliClaude', loginKey: 'cliClaudeLogin' },
  { cli: 'codex', nameKey: 'cliCodex', loginKey: 'cliCodexLogin' },
  { cli: 'pi', nameKey: 'cliPi', loginKey: 'cliPiLogin' },
  { cli: 'kimi', nameKey: 'cliKimi', loginKey: 'cliKimiLogin' },
]

const group: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }
const title: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
}
const cardHead: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const name: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 }
const detail: CSSProperties = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }
const output: CSSProperties = {
  margin: 0, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  fontSize: 11, color: 'var(--dsw-alias-label-tertiary)',
}
const errorStyle: CSSProperties = { ...detail, color: 'var(--dsw-alias-state-error-primary)' }
const actions: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

/** Render the official CLI setup cards below the engine controls. */
export function CliSetupSection({ client, t }: CliSetupSectionProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<CliSetupSnapshot>(() => client.getSnapshot())
  useEffect(() => {
    const unsubscribe = client.subscribe(setSnapshot)
    void client.load()
    return unsubscribe
  }, [client])

  return (
    <section aria-labelledby="cli-setup-title" style={group}>
      <div style={cardHead}>
        <h4 id="cli-setup-title" style={title}>{t('cliSetupTitle')}</h4>
        <Button variant="outline" onClick={() => { void client.load() }} disabled={snapshot.loading}>
          {snapshot.loading ? t('cliChecking') : t('cliRefresh')}
        </Button>
      </div>
      <p style={detail}>{t('cliSetupDescription')}</p>
      <div style={actions}>
        <Button
          variant="outline"
          disabled={snapshot.loading || snapshot.restartBusy || snapshot.error !== null
            || Object.values(snapshot.jobs).some((job) => job?.state === 'running')}
          onClick={() => { void client.prepareRestart() }}
        >
          {snapshot.restartBusy ? t('cliPreparingRestart') : t('cliPrepareRestart')}
        </Button>
      </div>
      {snapshot.restartPreparation !== null ? <>
        <p role="status" style={detail}>{snapshot.restartPreparation.message}</p>
        <p style={detail}>{t('cliLauncherPath')}: {snapshot.restartPreparation.launcherPath}</p>
        <p style={detail}>{t('cliExitToRestart')}</p>
      </> : null}
      {snapshot.error !== null ? <p role="alert" style={errorStyle}>{t('cliRemoteUnavailable')}: {snapshot.error}</p> : null}
      {snapshot.loading && Object.keys(snapshot.statuses).length === 0 ? <p style={detail}>{t('cliChecking')}</p> : null}
      {cards.map(({ cli, nameKey, loginKey }) => {
        const status = snapshot.statuses[cli]
        const job = snapshot.jobs[cli]
        const running = job?.state === 'running'
        const isInstalled = status?.installed === true
        const actionLabel = isInstalled ? t('cliValidate') : t('cliInstall')
        return (
          <article key={cli} style={card} aria-label={t(nameKey)}>
            <div style={cardHead}>
              <h5 style={name}>{t(nameKey)}</h5>
              <div style={actions}>
                <Button
                  variant="outline"
                  disabled={!isInstalled || running || snapshot.loading || snapshot.error !== null || snapshot.launching !== null}
                  onClick={() => { void client.launch(cli) }}
                >
                  {snapshot.launching === cli ? t('cliLaunching') : t('cliLaunch')}
                </Button>
                <Button
                  variant="outline"
                  disabled={running || snapshot.loading || snapshot.error !== null}
                  onClick={() => { void (isInstalled ? client.validate(cli) : client.startInstall(cli)) }}
                >
                  {running ? t('cliRunning') : actionLabel}
                </Button>
              </div>
            </div>
            {status === undefined
              ? <p style={detail}>{t('cliStatusUnknown')}</p>
              : <>
                <p style={detail}>{status.installed ? t('cliInstalled') : t('cliNotInstalled')}</p>
                {status.executable !== null ? <p style={detail}>{t('cliPath')}: {status.executable}</p> : null}
                {status.version !== null ? <p style={detail}>{t('cliVersion')}: {status.version}</p> : null}
                {status.validation === 'passed' ? <p style={detail}>{t('cliValidationPassed')}</p> : null}
                {status.validation === 'failed' && status.message !== null ? <p role="alert" style={errorStyle}>{t('cliValidationFailed')}: {status.message}</p> : null}
              </>}
            <p style={detail}>{t(loginKey)}</p>
            {job?.state === 'succeeded' ? <p style={detail}>{t('cliInstallSuccess')}</p> : null}
            {job?.state === 'failed' ? <p role="alert" style={errorStyle}>{t('cliInstallFailure')}: {job.error}</p> : null}
            {job !== undefined && job.output !== '' ? <pre style={output}>{job.output}</pre> : null}
          </article>
        )
      })}
    </section>
  )
}
