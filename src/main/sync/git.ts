import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { AppError } from '@shared/errors'

interface GitInfo {
  path: string
  version: string
}

export interface GitRunOptions {
  cwd: string
  token?: string | null
  proxy?: string | null
  timeoutMs?: number
}

interface GitOutput {
  stdout: string
  stderr: string
}

let cachedGit: GitInfo | null = null
let hooksDirPromise: Promise<string> | null = null

function candidatePaths(): string[] {
  const candidates = [
    process.env['MINIDIARY_GIT_PATH'],
    'git',
    '/usr/bin/git',
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/opt/local/bin/git',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    process.env['LOCALAPPDATA']
      ? path.join(process.env['LOCALAPPDATA'], 'Programs', 'Git', 'cmd', 'git.exe')
      : null
  ]
  return candidates.filter((item): item is string => Boolean(item))
}

function execFileAsync(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean }
          reject(Object.assign(failure, { stdout, stderr }))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

export async function findGit(): Promise<GitInfo> {
  if (cachedGit) return cachedGit
  for (const candidate of candidatePaths()) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], {
        timeoutMs: 10_000,
        env: process.env
      })
      const version = stdout.trim().replace(/^git version\s+/i, '')
      cachedGit = { path: candidate, version }
      return cachedGit
    } catch {
      // 继续尝试下一个
    }
  }
  throw new AppError('GIT_NOT_FOUND')
}

async function noHooksDir(): Promise<string> {
  if (!hooksDirPromise) {
    const dir = path.join(os.tmpdir(), `minidiary-nohooks-${process.pid}`)
    hooksDirPromise = fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => dir)
  }
  return hooksDirPromise
}

function gitEnv(entries: ReadonlyArray<[string, string]>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[key]
    }
  }
  // 代理只认应用内配置；不要把启动终端的 HTTPS_PROXY 意外带进 git
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key]
  }
  env['GIT_CONFIG_COUNT'] = String(entries.length)
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

function authHeader(token: string): string {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
}

function cleanMessage(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines.reverse().find((line) => !line.startsWith('warning:')) ?? ''
  return last.slice(0, 300)
}

export function classifyGitFailure(
  error: unknown,
  stderr: string,
  hasProxy: boolean
): AppError {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean }
  if (failure?.code === 'ENOENT') return new AppError('GIT_NOT_FOUND')
  const text = `${stderr}\n${failure?.message ?? ''}`.toLowerCase()

  const forbidden =
    text.includes('write access to repository not granted') ||
    text.includes('permission denied') ||
    /\b403\b/.test(text)
  const unauthorized =
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('terminal prompts disabled') ||
    text.includes('invalid username or password') ||
    /\b401\b/.test(text) ||
    text.includes('repository not found')
  if (forbidden) {
    return new AppError(
      'GIT_AUTH_FAILED',
      '令牌没有该仓库的写权限：Fine-grained token 需 Contents: Read and write，并选中这个私有仓库'
    )
  }
  if (unauthorized) {
    return new AppError('GIT_AUTH_FAILED', 'Git 认证失败：令牌无效、已过期，或没有访问该仓库的权限')
  }
  if (text.includes('could not resolve host') || text.includes('name or service not known')) {
    return new AppError('GIT_DNS', '无法解析仓库域名，请检查网络或 DNS')
  }
  if (
    hasProxy &&
    (text.includes('proxy') ||
      text.includes('failed to connect') ||
      text.includes('connection timed out') ||
      text.includes('timed out') ||
      text.includes('connect tunnel'))
  ) {
    return new AppError('GIT_PROXY', '无法连接 Git 代理，请确认代理已开启')
  }
  if (
    text.includes('non-fast-forward') ||
    text.includes('fetch first') ||
    text.includes('not possible to fast-forward') ||
    text.includes('diverged')
  ) {
    return new AppError('SYNC_CONFLICT')
  }
  if (text.includes('does not appear to be a git repository') || text.includes('no such remote')) {
    return new AppError('SYNC_NOT_CONFIGURED')
  }
  return new AppError('GIT_NETWORK', cleanMessage(stderr) || undefined)
}

export async function runGit(
  args: string[],
  options: GitRunOptions
): Promise<GitOutput> {
  const git = await findGit()
  const hooks = await noHooksDir()
  const entries: Array<[string, string]> = [
    ['core.hooksPath', hooks],
    ['core.fsmonitor', 'false'],
    ['credential.helper', '']
  ]
  if (options.proxy) {
    entries.push(['http.proxy', options.proxy])
    // 与用户常用的 git config 完全同形：URL-specific 优先，避免被全局配置盖掉
    entries.push(['http.https://github.com.proxy', options.proxy])
  }
  if (options.token) entries.push(['http.extraHeader', authHeader(options.token)])

  try {
    return await execFileAsync(git.path, ['--no-pager', ...args], {
      cwd: options.cwd,
      env: gitEnv(entries),
      timeoutMs: options.timeoutMs ?? 120_000
    })
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    throw classifyGitFailure(error, stderr, Boolean(options.proxy))
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, '.git'))
    return true
  } catch {
    return false
  }
}

export async function initRepo(cwd: string, repoUrl: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 })
  if (!(await isGitRepo(cwd))) {
    try {
      await runGit(['init', '-b', 'main'], { cwd })
    } catch {
      await runGit(['init'], { cwd })
      await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd })
    }
  }
  try {
    await runGit(['remote', 'get-url', 'origin'], { cwd })
    await runGit(['remote', 'set-url', 'origin', repoUrl], { cwd })
  } catch {
    await runGit(['remote', 'add', 'origin', repoUrl], { cwd })
  }
}

export async function statusPorcelain(options: GitRunOptions): Promise<string> {
  const { stdout } = await runGit(['status', '--porcelain'], options)
  return stdout
}

export async function aheadBehind(
  options: GitRunOptions
): Promise<{ ahead: number; behind: number; tracking: boolean }> {
  try {
    const { stdout } = await runGit(
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      options
    )
    const [aheadRaw, behindRaw] = stdout.trim().split(/\s+/)
    return {
      ahead: Number(aheadRaw ?? 0) || 0,
      behind: Number(behindRaw ?? 0) || 0,
      tracking: true
    }
  } catch {
    return { ahead: 0, behind: 0, tracking: false }
  }
}

interface CommitResult {
  committed: boolean
  changed: number
}

export async function commitAll(
  options: GitRunOptions,
  message: string
): Promise<CommitResult> {
  await runGit(['add', '-A'], options)
  const status = await statusPorcelain(options)
  if (!status.trim()) return { committed: false, changed: 0 }
  await runGit(
    ['-c', 'user.name=Mini Diary', '-c', 'user.email=mini-diary@localhost', 'commit', '-m', message],
    options
  )
  return { committed: true, changed: status.split('\n').filter(Boolean).length }
}

export async function push(options: GitRunOptions, branch: string): Promise<void> {
  await runGit(['push', '-u', 'origin', `HEAD:${branch}`], { ...options, timeoutMs: 180_000 })
}

export async function fetchOrigin(options: GitRunOptions): Promise<void> {
  await runGit(['fetch', '--prune', 'origin'], { ...options, timeoutMs: 180_000 })
}

export async function checkoutRemoteBranch(
  options: GitRunOptions,
  branch: string
): Promise<void> {
  await runGit(['checkout', '-B', branch, `origin/${branch}`], { ...options, timeoutMs: 120_000 })
}

export async function pullFastForward(
  options: GitRunOptions,
  branch: string
): Promise<void> {
  await runGit(['merge', '--ff-only', `origin/${branch}`], { ...options, timeoutMs: 120_000 })
}

/** ref 是否是 HEAD 的祖先（用于判断谁落后/分叉） */
export async function isAncestor(
  ancestor: string,
  descendant: string,
  options: GitRunOptions
): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant], options)
    return true
  } catch {
    return false
  }
}

export async function resetHard(options: GitRunOptions, ref: string): Promise<void> {
  await runGit(['reset', '--hard', ref], options)
}

export async function lsRemote(options: GitRunOptions): Promise<string> {
  const { stdout } = await runGit(['ls-remote', '--heads', 'origin'], {
    ...options,
    timeoutMs: 45_000
  })
  return stdout
}
