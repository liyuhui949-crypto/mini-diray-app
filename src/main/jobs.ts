import { randomUuid } from './vault/crypto'

import { broadcast } from './broadcast'
import { EVENTS } from '@shared/ipc'
import type { JobDonePayload, JobProgress } from '@shared/types'

export type JobKind = JobProgress['kind']

export interface JobHandle {
  id: string
  kind: JobKind
  signal: AbortSignal
  /** 0..1，超出范围会被夹紧 */
  report: (ratio: number, label: string, extra?: { bytesDone?: number; bytesTotal?: number }) => void
  done: (payload?: Omit<JobDonePayload, 'jobId' | 'kind'>) => void
  fail: (message: string) => void
}

/**
 * 任务注册表：迁移/导入/导出/附件写入都只能有一个前台任务，
 * 支持取消（AbortController）与进度广播。
 */
export class JobRegistry {
  private readonly jobs = new Map<string, { controller: AbortController; kind: JobKind }>()
  private busyJobId: string | null = null

  get activeJobId(): string | null {
    return this.busyJobId
  }

  get isBusy(): boolean {
    return this.busyJobId !== null
  }

  create(kind: JobKind): JobHandle {
    const id = randomUuid()
    const controller = new AbortController()
    this.jobs.set(id, { controller, kind })
    // 迁移/导入/导出互斥；附件写入允许并发但共用同一个 jobId 语义
    if (kind !== 'attachment') this.busyJobId = id

    const emit = (ratio: number, label: string, extra?: { bytesDone?: number; bytesTotal?: number }): void => {
      broadcast(EVENTS.jobProgress, {
        jobId: id,
        kind,
        ratio: Math.min(1, Math.max(0, ratio)),
        label,
        ...extra
      })
    }

    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      this.jobs.delete(id)
      if (this.busyJobId === id) this.busyJobId = null
    }

    return {
      id,
      kind,
      signal: controller.signal,
      report: emit,
      done: (payload = {}) => {
        finish()
        broadcast(EVENTS.jobDone, { jobId: id, kind, ...payload })
      },
      fail: (message: string) => {
        finish()
        broadcast(EVENTS.jobError, { jobId: id, kind, message })
      }
    }
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    job.controller.abort()
    return true
  }

  /** 锁定/退出时中止所有任务 */
  cancelAll(): void {
    for (const job of this.jobs.values()) job.controller.abort()
    this.jobs.clear()
    this.busyJobId = null
  }

  isCancelled(jobId: string): boolean {
    return this.jobs.get(jobId)?.controller.signal.aborted ?? true
  }
}

export const jobs = new JobRegistry()
