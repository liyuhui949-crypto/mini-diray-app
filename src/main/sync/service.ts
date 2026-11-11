import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'
import type { SyncMissingAttachment, SyncStatus, SyncTestResult } from '@shared/sync'
import { todayLocalDate } from '@shared/date'

import type { PreferencesStore } from '../preferences'
import type { VaultRepository } from '../vault/repository'
import { pathExists } from '../vault/paths'
import {
  aheadBehind,
  checkoutRemoteBranch,
  commitAll,
  fetchOrigin,
  findGit,
  initRepo,
  isAncestor,
  isGitRepo,
  lsRemote,
  pullFastForward,
  resetHard,
  push as pushGit,
  runGit,
  statusPorcelain,
  type GitRunOptions
} from './git'
import { buildMirror, readMirror, readMirrorVaultId, syncRoot } from './mirror'
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

  private async withTokenKey<T>(fn: (key: Buffer, vaultId: string) => Promise<T>): Promise<T> {
    if (!this.repository.isUnlocked) throw new AppError('VAULT_LOCKED')
    const key = this.repository.getSyncTokenKey()
    try {
      return await fn(key, this.repository.getVaultId())
    } finally {
      key.fill(0)
    }
  }

  /** 清空/重建前调用；有同步任务时拒绝改动 .sync */
  assertIdle(): void {
    if (this.running) throw new AppError('SYNC_BUSY')
  }

  /** 删除派生镜像并确认真的删掉了；失败时抛出，不静默继续清空 */
  async clearMirror(): Promise<void> {
    const root = syncRoot(this.repository.vaultDir)
    const message = '同步文件夹删除失败，请关闭占用它的程序后重试'
    try {
      await fs.rm(root, { recursive: true, force: true })
    } catch {
      throw new AppError('IO_ERROR', message)
    }
    if (await pathExists(root)) throw new AppError('IO_ERROR', message)
  }

  /** 旧 vault 留下的镜像不能复用，否则新仓库会被误判成“另一个日记库” */
  private async discardMismatchedMirror(): Promise<void> {
    if (!this.repository.isUnlocked) return
    const root = syncRoot(this.repository.vaultDir)
    const vaultId = await readMirrorVaultId(root)
    if (vaultId && vaultId !== this.repository.getVaultId()) {
      await this.clearMirror()
    }
  }

  private async readToken(): Promise<string | null> {
    if (!this.repository.isUnlocked) return null
    return this.withTokenKey((key, vaultId) => this.secrets.get(key, vaultId))
  }

  private async tokenOrThrow(): Promise<string> {
    const token = await this.readToken()
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
    const enabled = prefs.syncEnabled === true
    const repo = prefs.syncRepo ?? null
    let gitAvailable = false
    let gitVersion: string | null = null
    if (enabled) {
      try {
        const git = await findGit()
        gitAvailable = true
        gitVersion = git.version
      } catch {
        gitAvailable = false
      }
    }

    const token = enabled ? await this.readToken() : null
    const tokenSaved = enabled ? Boolean(token) : await this.secrets.has().catch(() => false)
    let ahead = 0
    let behind = 0
    let tracking = false
    let dirty = false
    if (enabled && repo && gitAvailable && (await isGitRepo(syncRoot(this.repository.vaultDir)))) {
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
      enabled,
      configured: Boolean(repo),
      gitAvailable,
      gitVersion,
      repo,
      branch: prefs.syncBranch ?? 'main',
      proxy: normalizeProxy(prefs.syncProxy),
      tokenSaved,
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
    this.assertIdle()
    const repo = validateRepoUrl(input.repo)
    const previousRepo = this.preferences.current.syncRepo
    if (input.token !== undefined && input.token.trim().length === 0) {
      throw new AppError('INVALID_INPUT', '访问令牌不能为空')
    }
    const token = input.token
    if (token !== undefined) {
      await this.withTokenKey((key, vaultId) => this.secrets.set(token.trim(), key, vaultId))
    }
    await this.preferences.update({
      syncRepo: repo,
      syncBranch: input.branch?.trim() || this.preferences.current.syncBranch || 'main',
      syncProxy: normalizeProxy(input.proxy)
    })

    // 换仓库时旧镜像直接作废；本地正文仍在 vault，下一次推送会重建
    if (previousRepo && previousRepo !== repo) await this.clearMirror()
    if (this.preferences.current.syncEnabled === true) await this.prepareRepo()
    return this.status()
  }

  private assertEnabled(): void {
    if (this.preferences.current.syncEnabled !== true) {
      throw new AppError('SYNC_DISABLED')
    }
  }

  async clearToken(): Promise<void> {
    await this.secrets.clear()
  }

  async setEnabled(enabled: boolean): Promise<SyncStatus> {
    return this.withLock(async () => {
      if (enabled) await this.prepareRepo()
      await this.preferences.update({ syncEnabled: enabled })
      return this.status()
    })
  }

  async test(): Promise<SyncTestResult> {
    return this.withLock(async () => {
      this.assertEnabled()
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

  /** 探测系统 git，并在已配置仓库时初始化本地 .sync（纯本地操作） */
  private async prepareRepo(): Promise<void> {
    await this.discardMismatchedMirror()
    await findGit()
    const repo = this.preferences.current.syncRepo
    if (repo) await initRepo(syncRoot(this.repository.vaultDir), repo)
  }

  private async ensureRepo(): Promise<void> {
    if (!this.preferences.current.syncRepo) throw new AppError('SYNC_NOT_CONFIGURED')
    await this.prepareRepo()
  }

  private async hasRef(ref: string, options: GitRunOptions): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--verify', ref], options)
      return true
    } catch {
      return false
    }
  }

  private async hasHead(cwd: string): Promise<boolean> {
    return this.hasRef('HEAD', { cwd })
  }

  async push(): Promise<{ commits: number; changed: number }> {
    return this.withLock(async () => {
      this.assertEnabled()
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
        const branch = prefs.syncBranch ?? 'main'
        await fetchOrigin(options)
        const remoteRef = `refs/remotes/origin/${branch}`
        if ((await this.hasRef(remoteRef, options)) && !(await isAncestor(remoteRef, 'HEAD', options))) {
          throw new AppError('SYNC_CONFLICT')
        }
        await pushGit(options, branch)
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
      this.assertEnabled()
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
          // 本地镜像只是日记库的派生缓存：先提交成临时快照，分叉时才能安全让位给远端
          await commitAll(options, 'sync: 拉取前本地快照')
          await fetchOrigin(options)
          const remoteRef = `refs/remotes/origin/${branch}`
          if (await this.hasRef(remoteRef, options)) {
            const localAhead = await isAncestor(remoteRef, 'HEAD', options)
            const localBehind = await isAncestor('HEAD', remoteRef, options)
            if (!localAhead) {
              if (localBehind) {
                await pullFastForward(options, branch)
              } else {
                // 两边各有提交：本地镜像可以丢弃，日记正文仍在 vault 里
                await resetHard(options, remoteRef)
              }
            }
          }
        } else {
          // 新接入：本地还没有任何提交，先取远端；远端为空时保持空仓库。
          // fetch 失败（代理/认证）必须抛出，不能当成“空仓库”静默成功。
          await fetchOrigin(options)
          const remoteRef = `refs/remotes/origin/${branch}`
          if (await this.hasRef(remoteRef, options)) {
            await checkoutRemoteBranch(options, branch)
          }
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
