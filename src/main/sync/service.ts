import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'
import type { SyncMissingAttachment, SyncStatus, SyncTestResult } from '@shared/sync'
import { todayLocalDate } from '@shared/date'

import type { PreferencesStore } from '../preferences'
import type { VaultRepository } from '../vault/repository'
import {
  aheadBehind,
  checkoutRemoteBranch,
  commitAll,
  fetchOrigin,
  findGit,
  initRepo,
  isGitRepo,
  lsRemote,
  pullFastForward,
  push as pushGit,
  runGit,
  statusPorcelain
} from './git'
import { buildMirror, readMirror, syncRoot } from './mirror'
import { SyncSecrets } from './secrets'

interface SyncServiceDeps {
  repository: VaultRepository
  preferences: PreferencesStore
  secrets?: SyncSecrets
}

function validateRepoUrl(value: string): string {
  const raw = value.trim()
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new AppError('INVALID_INPUT', '仓库地址不合法')
  }
  const allowLocal = process.env['MINIDIARY_ALLOW_LOCAL_REMOTE'] === '1'
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'file:')) {
    throw new AppError('INVALID_INPUT', '只支持 https:// 的 Git 仓库地址')
  }
  if (!url.pathname || url.pathname === '/') {
    throw new AppError('INVALID_INPUT', '仓库地址需要包含 owner/repo')
  }
  return candidate
}

function normalizeProxy(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  if (!/^(https?|socks5h?):\/\//i.test(trimmed)) {
    throw new AppError('INVALID_INPUT', '代理地址必须以 http://、https:// 或 socks5:// 开头')
  }
  return trimmed
}

export class SyncService {
  private readonly repository: VaultRepository
  private readonly preferences: PreferencesStore
  private readonly secrets: SyncSecrets
  private running = false

  constructor(deps: SyncServiceDeps) {
    this.repository = deps.repository
    this.preferences = deps.preferences
    this.secrets = deps.secrets ?? new SyncSecrets()
  }

  private localOptions(): { cwd: string; proxy: string | null } {
    return {
      cwd: syncRoot(this.repository.vaultDir),
      proxy: normalizeProxy(this.preferences.current.syncProxy)
    }
  }

  private async tokenOrThrow(): Promise<string> {
    const token = await this.secrets.get().catch(() => null)
    if (!token) throw new AppError('GIT_AUTH_FAILED', '还没有保存 Git 访问令牌')
    return token
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) throw new AppError('SYNC_BUSY')
    this.running = true
    try {
      return await fn()
    } finally {
      this.running = false
    }
  }

  private async rememberResult(ok: boolean, message: string | null): Promise<void> {
    await this.preferences.update({
      syncLastAt: ok ? new Date().toISOString() : this.preferences.current.syncLastAt ?? null,
      syncLastResult: ok ? 'ok' : 'error',
      syncLastMessage: ok ? null : message
    })
  }

  async status(): Promise<SyncStatus> {
    const prefs = this.preferences.current
    const repo = prefs.syncRepo ?? null
    let gitAvailable = false
    let gitVersion: string | null = null
    try {
      const git = await findGit()
      gitAvailable = true
      gitVersion = git.version
    } catch {
      gitAvailable = false
    }

    const token = await this.secrets.get().catch(() => null)
    let ahead = 0
    let behind = 0
    let tracking = false
    let dirty = false
    if (repo && gitAvailable && (await isGitRepo(syncRoot(this.repository.vaultDir)))) {
      try {
        const result = await aheadBehind({ ...this.localOptions(), token })
        ahead = result.ahead
        behind = result.behind
        tracking = result.tracking
        dirty = (await statusPorcelain({ ...this.localOptions(), token })).trim().length > 0
      } catch {
        // 没有 upstream / 空仓库时保持 0
      }
    }

    return {
      configured: Boolean(repo),
      gitAvailable,
      gitVersion,
      repo,
      branch: prefs.syncBranch ?? 'main',
      proxy: normalizeProxy(prefs.syncProxy),
      tokenSaved: Boolean(token),
      ahead,
      behind,
      tracking,
      dirty,
      lastSyncAt: prefs.syncLastAt ?? null,
      lastResult: prefs.syncLastResult ?? null,
      lastMessage: prefs.syncLastMessage ?? null
    }
  }

  async configure(input: {
    repo: string
    branch?: string
    proxy?: string | null
    token?: string
  }): Promise<SyncStatus> {
    const repo = validateRepoUrl(input.repo)
    if (input.token !== undefined && input.token.trim().length === 0) {
      throw new AppError('INVALID_INPUT', '访问令牌不能为空')
    }
    if (input.token !== undefined) await this.secrets.set(input.token.trim())
    await this.preferences.update({
      syncRepo: repo,
      syncBranch: input.branch?.trim() || this.preferences.current.syncBranch || 'main',
      syncProxy: normalizeProxy(input.proxy)
    })

    const cwd = syncRoot(this.repository.vaultDir)
    await initRepo(cwd, repo)
    return this.status()
  }

  async test(): Promise<SyncTestResult> {
    return this.withLock(async () => {
      const prefs = this.preferences.current
      if (!prefs.syncRepo) throw new AppError('SYNC_NOT_CONFIGURED')
      const token = await this.tokenOrThrow()
      const cwd = syncRoot(this.repository.vaultDir)
      const proxy = normalizeProxy(prefs.syncProxy)
      const started = Date.now()
      await lsRemote({ cwd, token, proxy })
      const latencyMs = Date.now() - started
      if (prefs.syncLastResult === 'error') {
        await this.preferences.update({ syncLastResult: null, syncLastMessage: null })
      }
      return {
        latencyMs,
        message: `连接成功 · github.com ${latencyMs}ms${proxy ? `（经代理 ${proxy}）` : ''}`
      }
    })
  }

  private async ensureRepo(): Promise<void> {
    const prefs = this.preferences.current
    if (!prefs.syncRepo) throw new AppError('SYNC_NOT_CONFIGURED')
    await findGit()
    const cwd = syncRoot(this.repository.vaultDir)
    await initRepo(cwd, prefs.syncRepo)
  }

  private async hasHead(cwd: string): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--verify', 'HEAD'], { cwd })
      return true
    } catch {
      return false
    }
  }

  async push(): Promise<{ commits: number; changed: number }> {
    return this.withLock(async () => {
      if (!this.repository.isUnlocked) throw new AppError('VAULT_LOCKED')
      await this.ensureRepo()
      const prefs = this.preferences.current
      const token = await this.tokenOrThrow()
      const options = { ...this.localOptions(), token }
      try {
        const { changed } = await buildMirror(this.repository, todayLocalDate())
        const result = await commitAll(
          options,
          `sync: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
        )
        await pushGit(options, prefs.syncBranch ?? 'main')
        await this.rememberResult(true, null)
        return { commits: result.committed ? 1 : 0, changed }
      } catch (error) {
        await this.rememberResult(false, error instanceof Error ? error.message : '推送失败')
        throw error
      }
    })
  }

  async pull(): Promise<{ entries: number; annotations: number }> {
    return this.withLock(async () => {
      if (!this.repository.isUnlocked) throw new AppError('VAULT_LOCKED')
      await this.ensureRepo()
      const prefs = this.preferences.current
      const token = await this.tokenOrThrow()
      const options = { ...this.localOptions(), token }
      const cwd = options.cwd
      const branch = prefs.syncBranch ?? 'main'
      try {
        const hasHead = await this.hasHead(cwd)
        if (hasHead) {
          await buildMirror(this.repository, todayLocalDate())
          if ((await statusPorcelain(options)).trim()) {
            throw new AppError('SYNC_CONFLICT', '本地有未推送改动，请先推送')
          }
          await fetchOrigin(options)
          await pullFastForward(options, branch)
        } else {
          // 新接入：本地还没有任何提交，先取远端；远端为空时保持空仓库。
          // fetch 失败（代理/认证）必须抛出，不能当成“空仓库”静默成功。
          await fetchOrigin(options)
          const remoteRef = `refs/remotes/origin/${branch}`
          const hasRemoteBranch = await runGit(['rev-parse', '--verify', remoteRef], options)
            .then(() => true)
            .catch(() => false)
          if (hasRemoteBranch) await checkoutRemoteBranch(options, branch)
        }
        const mirror = await readMirror(this.repository, todayLocalDate())
        const applied = await this.repository.applySync(mirror, todayLocalDate())
        await this.rememberResult(true, null)
        return applied
      } catch (error) {
        await this.rememberResult(false, error instanceof Error ? error.message : '拉取失败')
        throw error
      }
    })
  }

  async missingAttachments(): Promise<SyncMissingAttachment[]> {
    if (!this.repository.isUnlocked) return []
    const snapshot = this.repository.getSnapshot()
    const missing: SyncMissingAttachment[] = []
    const seen = new Set<string>()
    for (const entry of snapshot.entries) {
      for (const attachment of entry.attachments) {
        if (seen.has(attachment.id)) continue
        seen.add(attachment.id)
        const file = path.join(this.repository.vaultDir, 'attachments', `${attachment.id}.mdat`)
        const exists = await fs
          .stat(file)
          .then(() => true)
          .catch(() => false)
        if (!exists) {
          missing.push({
            id: attachment.id,
            name: attachment.name,
            date: entry.date,
            size: attachment.size,
            kind: attachment.kind
          })
        }
      }
    }
    return missing
  }
}
