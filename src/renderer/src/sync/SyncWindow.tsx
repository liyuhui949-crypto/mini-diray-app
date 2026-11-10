import { useCallback, useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'
import type { Preferences, StorageStats } from '@shared/types'
import type { SyncStatus, SyncTab } from '@shared/sync'

import { call, errorMessage, subscribe } from '@/api/client'
import { Button, Dialog, Field, ToastHost } from '@/components/ui'
import { useUiStore } from '@/stores/ui'

import styles from './sync.module.scss'

type Loading = 'push' | 'pull' | 'test' | 'save' | 'export' | 'import' | 'reset' | null

function initialTab(): SyncTab {
  const value = new URLSearchParams(window.location.search).get('tab')
  return value === 'data' ? 'data' : 'git'
}

function repoLabel(repo: string | null): string {
  if (!repo) return copy.sync.repoUnset
  return repo.replace(/^https:\/\//, '').replace(/\.git$/, '')
}

function lastSyncLabel(status: SyncStatus): string {
  if (status.lastResult === 'error' && status.lastMessage) {
    return copy.sync.lastFailed(status.lastMessage)
  }
  if (!status.lastSyncAt) return copy.sync.statusIdle
  const date = new Date(status.lastSyncAt)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return copy.sync.lastSync(stamp)
}

function statusLine(status: SyncStatus | null): string {
  if (!status || !status.configured) return copy.sync.statusIdle
  if (status.dirty && status.ahead === 0) return '有未推送改动'
  if (!status.tracking) return copy.sync.statusNever
  if (status.ahead > 0 && status.behind > 0) {
    return copy.sync.statusDiverged(status.ahead, status.behind)
  }
  if (status.ahead > 0) return copy.sync.statusAhead(status.ahead)
  if (status.behind > 0) return copy.sync.statusBehind(status.behind)
  return copy.sync.statusClean
}

export function SyncWindow(): React.JSX.Element {
  const [tab, setTab] = useState<SyncTab>(initialTab)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [prefs, setPrefs] = useState<Preferences | null>(null)
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [missing, setMissing] = useState(0)
  const [loading, setLoading] = useState<Loading>(null)
  const [edit, setEdit] = useState<'repo' | 'token' | 'proxy' | null>(null)
  const [repoInput, setRepoInput] = useState('')
  const [branchInput, setBranchInput] = useState('main')
  const [proxyInput, setProxyInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [resetDelete, setResetDelete] = useState('')
  const pushToast = useUiStore((state) => state.pushToast)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await call('sync:status', undefined)
    setStatus(next)
    setRepoInput(next.repo ?? '')
    setBranchInput(next.branch)
    setProxyInput(next.proxy ?? '')
    const missingList = await call('sync:missingAttachments', undefined).catch(() => [])
    setMissing(missingList.length)
  }, [])

  useEffect(() => {
    document.title = '同步 — Mini Diary'
    void (async () => {
      try {
        const nextPrefs = await call('prefs:read', undefined)
        setPrefs(nextPrefs)
        document.documentElement.dataset['theme'] =
          nextPrefs.theme === 'system'
            ? window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light'
            : nextPrefs.theme
        setStats(await call('stats:storage', undefined))
        await refresh()
      } catch (error) {
        pushToast(errorMessage(error), { tone: 'error' })
      }
    })()
  }, [pushToast, refresh])

  useEffect(() => {
    return subscribe('sync:tab', ({ tab: next }) => setTab(next))
  }, [])

  useEffect(() => {
    const applyTheme = (theme: string): void => {
      if (theme !== 'system') {
        document.documentElement.dataset['theme'] = theme
        return
      }
      document.documentElement.dataset['theme'] = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light'
    }
    return subscribe('theme:changed', ({ theme }) => applyTheme(theme))
  }, [])

  const run = async (
    kind: Loading,
    task: () => Promise<void>,
    failPrefix?: string
  ): Promise<void> => {
    setLoading(kind)
    try {
      await task()
    } catch (error) {
      const message = errorMessage(error)
      pushToast(failPrefix ? `${failPrefix} · ${message}` : message, { tone: 'error' })
    } finally {
      await refresh().catch(() => undefined)
      setStats(await call('stats:storage', undefined).catch(() => stats))
      setLoading(null)
    }
  }

  const saveRepo = (): void => {
    void run('save', async () => {
      await call('sync:configure', {
        repo: repoInput.trim(),
        branch: branchInput.trim() || 'main',
        proxy: proxyInput.trim() || null
      })
      setEdit(null)
      pushToast('仓库地址已保存')
    })
  }

  const saveToken = (): void => {
    void run('save', async () => {
      if (!tokenInput.trim()) throw new Error('请输入 Git 访问令牌')
      await call('sync:configure', {
        repo: repoInput.trim(),
        branch: branchInput.trim() || 'main',
        proxy: proxyInput.trim() || null,
        token: tokenInput.trim()
      })
      setTokenInput('')
      setEdit(null)
      pushToast(copy.sync.tokenSaved)
    })
  }

  const saveProxy = (): void => {
    void run('save', async () => {
      await call('sync:configure', {
        repo: repoInput.trim(),
        branch: branchInput.trim() || 'main',
        proxy: proxyInput.trim() || null
      })
      setEdit(null)
      pushToast('代理设置已保存')
    })
  }

  const push = (): void => {
    void run(
      'push',
      async () => {
        const result = await call('sync:push', undefined)
        pushToast(
          result.commits > 0 ? copy.sync.pushDone(result.changed) : copy.sync.pushNoChange,
          { tone: 'success' }
        )
      },
      '推送失败 · 待推送内容仍保留在本地'
    )
  }

  const pull = (): void => {
    void run(
      'pull',
      async () => {
        const result = await call('sync:pull', undefined)
        pushToast(
          result.entries + result.annotations > 0
            ? copy.sync.pullDone(result.entries, result.annotations)
            : copy.sync.pullNoChange,
          { tone: 'success' }
        )
      },
      '拉取失败 · 请检查网络或代理后重试'
    )
  }

  const test = (): void => {
    void run(
      'test',
      async () => {
        const result = await call('sync:test', undefined)
        pushToast(copy.sync.testDone(result.message), { tone: 'success' })
      },
      '连接失败'
    )
  }

  const exportAttachments = (): void => {
    void run('export', async () => {
      const result = await call('attachment:exportPackage', undefined)
      if (!result.path) return
      pushToast(copy.sync.attachmentExportDone(result.count, formatBytes(result.bytes)), {
        tone: 'success'
      })
    })
  }

  const importAttachments = (): void => {
    void run('import', async () => {
      const result = await call('attachment:importPackage', undefined)
      pushToast(
        copy.sync.attachmentImportDone(result.imported, result.skipped, result.missing),
        { tone: 'success' }
      )
    })
  }

  const openDir = (): void => {
    void call('app:openDiaryDir', undefined).catch((error) => {
      pushToast(errorMessage(error), { tone: 'error' })
    })
  }

  const changeDir = (): void => {
    void run('save', async () => {
      const picked = await call('dialog:pickDirectory', { purpose: 'diaryDir' })
      if (!picked.path) return
      const next = await call('vault:moveDirectory', { targetDir: picked.path })
      setPrefs((current) => (current ? { ...current, diaryDir: next.diaryDir } : current))
      pushToast('日记目录已更改')
    })
  }

  const doReset = (): void => {
    void run('reset', async () => {
      await call('vault:reset', { password: resetPassword })
      setResetOpen(false)
      setResetPassword('')
      setResetDelete('')
      pushToast(copy.sync.resetDone, { tone: 'success' })
    })
  }

  const gitReady = status?.gitAvailable !== false
  const configured = Boolean(status?.configured)
  const busy = loading !== null

  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.title}>同步 — Mini Diary</span>
        <button type="button" className={styles.close} aria-label={copy.sync.close} onClick={() => window.close()}>
          ×
        </button>
      </div>

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'git'}
          className={tab === 'git' ? styles.tabActive : styles.tab}
          onClick={() => setTab('git')}
        >
          {copy.sync.gitTab}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'data'}
          className={tab === 'data' ? styles.tabActive : styles.tab}
          onClick={() => setTab('data')}
        >
          {copy.sync.dataTab}
        </button>
      </div>

      {tab === 'git' ? (
        <section className={styles.body}>
          <h2>{copy.sync.gitTab}</h2>
          <p className={styles.intro}>{copy.sync.intro}</p>

          {!gitReady ? <div className={styles.warn}>{copy.sync.gitMissing}</div> : null}
          {gitReady && !configured ? <div className={styles.warn}>{copy.sync.notConfigured}</div> : null}

          <div className={styles.card}>
            <div>
              <div className={styles.label}>{copy.sync.status}</div>
              <div className={styles.value}>{statusLine(status)}</div>
              <div className={styles.hint}>
                {status ? lastSyncLabel(status) : copy.sync.statusIdle}
                {status?.gitVersion ? ` · git ${status.gitVersion}` : ''}
              </div>
            </div>
            <div className={styles.actions}>
              <Button size="sm" disabled={!gitReady || !configured || !status?.tokenSaved || busy} onClick={pull}>
                {loading === 'pull' ? copy.sync.pullLoading : copy.sync.pull}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!gitReady || !configured || !status?.tokenSaved || busy}
                onClick={push}
              >
                {loading === 'push' ? copy.sync.pushLoading : copy.sync.push}
              </Button>
            </div>
          </div>

          <div className={styles.card}>
            <div>
              <div className={styles.label}>{copy.sync.repo}</div>
              <div className={styles.value}>{repoLabel(status?.repo ?? null)}</div>
              <div className={styles.hint}>{copy.sync.repoHint}</div>
              {edit === 'repo' ? (
                <div className={styles.form}>
                  <Field label={copy.sync.repo} htmlFor="sync-repo">
                    <input
                      id="sync-repo"
                      className={styles.input}
                      value={repoInput}
                      placeholder="https://github.com/owner/repo.git"
                      onChange={(event) => setRepoInput(event.target.value)}
                    />
                  </Field>
                  <Field label={copy.sync.branch} htmlFor="sync-branch">
                    <input
                      id="sync-branch"
                      className={styles.input}
                      value={branchInput}
                      onChange={(event) => setBranchInput(event.target.value)}
                    />
                  </Field>
                  <div className={styles.actions}>
                    <Button size="sm" onClick={() => setEdit(null)}>
                      {copy.sync.cancel}
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={saveRepo}>
                      {copy.sync.save}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            {edit !== 'repo' ? (
              <Button size="sm" onClick={() => setEdit('repo')}>
                {copy.sync.edit}
              </Button>
            ) : null}
          </div>

          <div className={styles.card}>
            <div>
              <div className={styles.label}>{copy.sync.token}</div>
              <div className={styles.value}>
                {status?.tokenSaved ? copy.sync.tokenSaved : copy.sync.tokenUnset}
              </div>
              <div className={styles.hint}>{copy.sync.tokenHint}</div>
              {edit === 'token' ? (
                <div className={styles.form}>
                  <Field label="GitHub Personal Access Token" htmlFor="sync-token">
                    <input
                      id="sync-token"
                      className={styles.input}
                      type="password"
                      autoComplete="off"
                      value={tokenInput}
                      placeholder="ghp_…"
                      onChange={(event) => setTokenInput(event.target.value)}
                    />
                  </Field>
                  <div className={styles.actions}>
                    <Button size="sm" onClick={() => setEdit(null)}>
                      {copy.sync.cancel}
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={saveToken}>
                      {copy.sync.save}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            {edit !== 'token' ? (
              <Button size="sm" onClick={() => setEdit('token')}>
                {status?.tokenSaved ? copy.sync.change : copy.sync.edit}
              </Button>
            ) : null}
          </div>

          <div className={styles.card}>
            <div>
              <div className={styles.label}>{copy.sync.proxy}</div>
              <div className={styles.value}>{status?.proxy ?? copy.sync.proxyUnset}</div>
              <div className={styles.hint}>{copy.sync.proxyHint}</div>
              {edit === 'proxy' ? (
                <div className={styles.form}>
                  <Field label={copy.sync.proxy} htmlFor="sync-proxy">
                    <input
                      id="sync-proxy"
                      className={styles.input}
                      value={proxyInput}
                      placeholder="http://127.0.0.1:7890"
                      onChange={(event) => setProxyInput(event.target.value)}
                    />
                  </Field>
                  <div className={styles.actions}>
                    <Button size="sm" onClick={() => setEdit(null)}>
                      {copy.sync.cancel}
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={saveProxy}>
                      {copy.sync.save}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className={styles.actions}>
              {edit !== 'proxy' ? (
                <Button size="sm" onClick={() => setEdit('proxy')}>
                  {copy.sync.edit}
                </Button>
              ) : null}
              <Button size="sm" disabled={!gitReady || !configured || !status?.tokenSaved || busy} onClick={test}>
                {loading === 'test' ? copy.sync.testLoading : copy.sync.test}
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <section className={styles.body}>
          <h2>{copy.sync.dataTab}</h2>

          <div className={styles.card}>
            <div>
              <div className={styles.label}>{copy.sync.dataDir}</div>
              <div className={styles.value}>{prefs?.diaryDir ?? ''}</div>
              <div className={styles.hint}>
                {copy.sync.dataDirHint}
                {stats
                  ? ` · ${stats.entryCount} 篇 · ${stats.attachmentCount} 个附件 · ${formatBytes(stats.attachmentBytes + stats.vaultBytes)}`
                  : ''}
              </div>
            </div>
            <div className={styles.actions}>
              <Button size="sm" onClick={openDir}>
                {copy.sync.openDir}
              </Button>
              <Button size="sm" disabled={busy} onClick={changeDir}>
                {copy.sync.changeDir}
              </Button>
            </div>
          </div>

          <div className={styles.card}>
            <div>
              <div className={styles.label}>{copy.sync.migration}</div>
              <div className={styles.hint}>{copy.sync.migrationHint}</div>
            </div>
            <div className={styles.actions}>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void call('sync:openMigration', { kind: 'import' })}
              >
                {copy.sync.migrationImport}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void call('sync:openMigration', { kind: 'export' })}
              >
                {copy.sync.migrationExport}
              </Button>
            </div>
          </div>

          <div className={styles.card}>
            <div>
              <div className={styles.label}>{copy.sync.attachmentPackage}</div>
              <div className={styles.hint}>
                {copy.sync.attachmentPackageHint}
                {missing > 0 ? ` · ${copy.sync.missing(missing)}` : ''}
              </div>
            </div>
            <div className={styles.actions}>
              <Button size="sm" disabled={busy} onClick={importAttachments}>
                {loading === 'import' ? '导入中…' : copy.sync.attachmentImport}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={exportAttachments}>
                {loading === 'export' ? '导出中…' : copy.sync.attachmentExport}
              </Button>
            </div>
          </div>

          <div className={styles.danger}>
            <div>
              <div className={styles.label}>{copy.sync.reset}</div>
              <div className={styles.hint}>{copy.sync.resetHint}</div>
            </div>
            <Button size="sm" variant="danger" onClick={() => setResetOpen(true)}>
              {copy.sync.resetAction}
            </Button>
          </div>
        </section>
      )}

      <Dialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={copy.sync.resetTitle}
        description={copy.sync.resetDesc}
        footer={
          <>
            <Button size="sm" onClick={() => setResetOpen(false)}>
              {copy.sync.cancel}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!resetPassword || resetDelete !== 'DELETE' || busy}
              onClick={doReset}
            >
              {copy.sync.resetConfirm}
            </Button>
          </>
        }
      >
        <Field label={copy.sync.resetPassword} htmlFor="reset-password">
          <input
            id="reset-password"
            className={styles.input}
            type="password"
            placeholder={copy.sync.resetPasswordPlaceholder}
            autoComplete="current-password"
            value={resetPassword}
            onChange={(event) => setResetPassword(event.target.value)}
          />
        </Field>
        <Field label={copy.sync.resetDelete} htmlFor="reset-delete">
          <input
            id="reset-delete"
            className={styles.input}
            placeholder={copy.sync.resetDeletePlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={resetDelete}
            onChange={(event) => setResetDelete(event.target.value)}
          />
        </Field>
      </Dialog>

      <ToastHost />
    </div>
  )
}
