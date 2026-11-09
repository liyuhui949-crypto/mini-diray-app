import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AppError } from '../../src/shared/errors'
import {
  ANNOTATION_MAGIC,
  annotationFile,
  annotationKey,
  appendAnnotation,
  buildAnnotation,
  formatAnnotationTime,
  normalizeAnnotationTag,
  normalizeQuote,
  readAnnotations
} from '../../src/main/vault/annotations'
import { VaultRepository } from '../../src/main/vault/repository'

const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'diary-password-1234'
const DATE = '2026-10-31'

async function tempDir(prefix = 'minidiary-ann-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

async function lockedRepo(dir: string): Promise<VaultRepository> {
  const repo = new VaultRepository({ dir, scrypt: FAST })
  await repo.create(PASSWORD)
  return repo
}

describe('annotation store', () => {
  it('tag 去掉前导 #、trim、截断 24 字；引文去空白并截断 90', () => {
    expect(normalizeAnnotationTag('  ##错别字  ')).toBe('错别字')
    expect(normalizeAnnotationTag('#'.repeat(3))).toBe('')
    expect(normalizeAnnotationTag('x'.repeat(40))).toHaveLength(24)
    expect(normalizeQuote(`  ${'字'.repeat(120)}  `)).toHaveLength(90)
    expect(normalizeQuote('  ')).toBe('')
  })

  it('buildAnnotation 生成 n+序号、MM-DD HH:mm 与时间戳', () => {
    const now = new Date(2026, 10, 7, 9, 5)
    const annotation = buildAnnotation(
      { date: DATE, quote: '加班到九点', tag: '#时间有误', body: ' 其实是九点半 ' },
      now.getTime() % 1000,
      now
    )
    expect(annotation.id).toMatch(/^n\d+$/)
    expect(annotation.tag).toBe('时间有误')
    expect(annotation.body).toBe('其实是九点半')
    expect(annotation.at).toBe(formatAnnotationTime(now))
    expect(annotation.at).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('追加后能读回；文件是 INKANN1 头 + 每行一条密文，磁盘无明文', async () => {
    const dir = await tempDir()
    try {
      const repo = await lockedRepo(dir)
      const key = annotationKey(repo.getDek(), repo.getVaultId())
      const first = buildAnnotation(
        { date: DATE, quote: '加班到九点', tag: '时间有误', body: '其实是九点半' },
        1
      )
      const second = buildAnnotation({ date: DATE, quote: '', tag: '', body: '整篇批注' }, 2)
      await appendAnnotation(dir, key, first)
      await appendAnnotation(dir, key, second)

      const records = await readAnnotations(dir, DATE, key)
      expect(records.map((item) => item.id)).toEqual([first.id, second.id])
      expect(records[1]?.quote).toBe('')

      const text = await readFile(annotationFile(dir, DATE), 'utf8')
      const lines = text.trim().split('\n')
      expect(lines[0]).toBe(ANNOTATION_MAGIC)
      expect(lines).toHaveLength(3)
      expect(text).not.toContain('其实是九点半')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('AAD 绑定日期：把记录搬到另一天就解不开', async () => {
    const dir = await tempDir()
    try {
      const repo = await lockedRepo(dir)
      const key = annotationKey(repo.getDek(), repo.getVaultId())
      const record = buildAnnotation({ date: DATE, quote: '', tag: 'x', body: '正文' }, 1)
      await appendAnnotation(dir, key, record)

      const original = await readFile(annotationFile(dir, DATE), 'utf8')
      await writeFile(annotationFile(dir, '2026-11-01'), original)
      await expect(readAnnotations(dir, '2026-11-01', key)).rejects.toMatchObject({
        code: 'CORRUPT_VAULT'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('篡改非末行会报错；只损坏最后一行时仍返回前面的记录', async () => {
    const dir = await tempDir()
    try {
      const repo = await lockedRepo(dir)
      const key = annotationKey(repo.getDek(), repo.getVaultId())
      await appendAnnotation(dir, key, buildAnnotation({ date: DATE, quote: '', body: '一', tag: '' }, 1))
      await appendAnnotation(dir, key, buildAnnotation({ date: DATE, quote: '', body: '二', tag: '' }, 2))

      const file = annotationFile(dir, DATE)
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
      await writeFile(file, `${lines[0]}\n${lines[1]}\n${lines[2]!.slice(0, 20)}\n`)
      // 末行被截断：丢最后一条，第一条仍在
      expect(await readAnnotations(dir, DATE, key)).toHaveLength(1)

      await writeFile(file, `${lines[0]}\n!!!\n${lines[2]!}\n`)
      await expect(readAnnotations(dir, DATE, key)).rejects.toMatchObject({ code: 'CORRUPT_VAULT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('repository annotations', () => {
  it('只增不改：id 单调递增、快照带批注、锁定后清空', async () => {
    const dir = await tempDir()
    try {
      const repo = await lockedRepo(dir)
      const today = new Date()
      const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
        today.getDate()
      ).padStart(2, '0')}`

      const first = await repo.addAnnotation({
        date: todayDate,
        quote: '一句',
        tag: '#错别字',
        body: '改成另一句'
      })
      const second = await repo.addAnnotation({ date: todayDate, quote: '', tag: '', body: '整篇' })
      expect(first.annotation.id).toBe('n1')
      expect(second.annotation.id).toBe('n2')
      expect(repo.getSnapshot().annotations[todayDate]).toHaveLength(2)
      expect(repo.getSnapshot().annotations[todayDate]?.[0]?.tag).toBe('错别字')

      repo.lock()
      await repo.unlock(PASSWORD)
      expect(repo.getSnapshot().annotations[todayDate]).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('未来日期拒绝；重置会清空批注文件', async () => {
    const dir = await tempDir()
    try {
      const repo = await lockedRepo(dir)
      await expect(
        repo.addAnnotation({ date: '2999-01-01', quote: '', tag: '', body: '未来' })
      ).rejects.toMatchObject({ code: 'INVALID_DATE' })

      const today = new Date()
      const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
        today.getDate()
      ).padStart(2, '0')}`
      await repo.addAnnotation({ date: todayDate, quote: '', tag: '', body: '留着' })
      expect((await readdir(path.join(dir, 'annotations'))).length).toBe(1)

      await repo.reset(PASSWORD)
      expect(repo.getSnapshot().annotations).toEqual({})
      expect(await readdir(path.join(dir, 'annotations')).catch(() => [])).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('批注内容为空时报 INVALID_INPUT', async () => {
    const dir = await tempDir()
    try {
      const repo = await lockedRepo(dir)
      await expect(
        repo.addAnnotation({ date: '2026-10-01', quote: '', tag: '', body: '   ' })
      ).rejects.toBeInstanceOf(AppError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
