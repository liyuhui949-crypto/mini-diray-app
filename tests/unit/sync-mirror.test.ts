import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { VaultRepository } from '../../src/main/vault/repository'
import { buildMirror, readMirror, syncEntriesDir, syncRoot } from '../../src/main/sync/mirror'

const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'diary-password-1234'
const TODAY = '2026-11-10'

async function tempDir(prefix = 'minidiary-sync-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

function draft(date: string, title: string, body: string) {
  return { date, title, body, tags: [], attachments: [] }
}

describe('sync mirror', () => {
  it('只写今天以前的条目与批注，且文件里没有明文', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-08', '前天', '前天的正文'))
      await repo.saveEntry(draft('2026-11-09', '昨天', '昨天的正文'))
      await repo.saveEntry(draft(TODAY, '今天', '今天的正文'))
      await repo.addAnnotation({ date: '2026-11-09', quote: '', tag: '', body: '昨天批注' })
      await repo.addAnnotation({ date: TODAY, quote: '', tag: '', body: '今天批注' })

      const built = await buildMirror(repo, TODAY)
      expect(built.changed).toBeGreaterThan(0)
      const entries = await readdir(syncEntriesDir(built.root))
      expect(entries).toEqual(['2026-11-08.ink', '2026-11-09.ink'])
      const annotations = await readdir(path.join(syncRoot(dir), 'annotations'))
      expect(annotations).toEqual(['2026-11-09.ann'])

      const raw = await readFile(path.join(syncEntriesDir(built.root), '2026-11-09.ink'), 'utf8')
      expect(raw.includes('昨天')).toBe(false)
      expect(raw.includes('正文')).toBe(false)
      const annotationRaw = await readFile(
        path.join(syncRoot(dir), 'annotations', '2026-11-09.ann'),
        'utf8'
      )
      expect(annotationRaw.includes('昨天批注')).toBe(false)

      const mirror = await readMirror(repo, TODAY)
      expect(mirror.entries.map((entry) => entry.date)).toEqual(['2026-11-08', '2026-11-09'])
      expect(mirror.annotations['2026-11-09']?.[0]?.body).toBe('昨天批注')
      expect(mirror.annotations[TODAY]).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('内容不变时不重写，改一篇只产生一个 M', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-08', 'A', 'A 正文'))
      await repo.saveEntry(draft('2026-11-09', 'B', 'B 正文'))
      const first = await buildMirror(repo, TODAY)
      const before = await readFile(path.join(syncEntriesDir(first.root), '2026-11-08.ink'))
      const second = await buildMirror(repo, TODAY)
      expect(second.changed).toBe(0)
      const after = await readFile(path.join(syncEntriesDir(first.root), '2026-11-08.ink'))
      expect(after.equals(before)).toBe(true)

      await repo.saveEntry(draft('2026-11-09', 'B 改', 'B 正文改了'))
      const third = await buildMirror(repo, TODAY)
      expect(third.changed).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('拉取合并：条目按日期、批注去重且 id 冲突时重排', async () => {
    const sourceDir = await tempDir()
    const targetDir = await tempDir()
    try {
      const source = new VaultRepository({ dir: sourceDir, scrypt: FAST })
      await source.create(PASSWORD)
      await source.saveEntry(draft('2026-11-08', '来源', '来源正文'))
      await source.addAnnotation({ date: '2026-11-08', quote: '', tag: '', body: '来源批注' })
      await source.flush()
      await buildMirror(source, TODAY)
      const remote = await readMirror(source, TODAY)

      // 目标库复制同一把 vault（同 vaultId/DEK），再在本地加一条 n1 批注制造 id 冲突
      await cp(path.join(sourceDir, 'diary.vault'), path.join(targetDir, 'diary.vault'))
      const target = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await target.unlock(PASSWORD)
      await target.addAnnotation({ date: '2026-11-08', quote: '', tag: '', body: '本地批注' })

      const applied = await target.applySync(remote, TODAY)
      expect(applied.entries).toBe(0) // 内容相同，不重复应用
      expect(applied.annotations).toBe(1)
      const annotations = target.getSnapshot().annotations['2026-11-08'] ?? []
      expect(annotations.map((item) => item.body).sort()).toEqual(['来源批注', '本地批注'].sort())
      expect(new Set(annotations.map((item) => item.id)).size).toBe(annotations.length)
    } finally {
      await rm(sourceDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })
})
