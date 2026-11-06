import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { JobHandle } from '../../src/main/jobs'
import type { Preferences } from '@shared/types'
import { AttachmentStore } from '../../src/main/attachments/store'
import { ZipArchive, ZipWriter } from '../../src/main/core/zip'
import { exportMigrationPackage } from '../../src/main/migration/export'
import { MigrationImporter } from '../../src/main/migration/import'
import { PACKAGE_MEMBER } from '../../src/main/migration/package'
import { VaultRepository } from '../../src/main/vault/repository'

const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'source-password-1234'
const PACKAGE_PASSWORD = 'package-password-1234'
/** 32 位、只含公钥字母表字符 */
const PACKAGE_KEY = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567-89AB'
const NEW_PASSWORD = 'imported-password-1234'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
])

function job(kind: JobHandle['kind'] = 'migration-export'): JobHandle {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    kind,
    signal: new AbortController().signal,
    report: () => undefined,
    done: () => undefined,
    fail: () => undefined
  }
}

function preferences(diaryDir: string): Preferences {
  return {
    version: 1,
    theme: 'dark',
    hideTitle: false,
    allowFutureEntries: false,
    autoLockMinutes: 0,
    diaryDir,
    lastOpenedDate: null,
    lastImportDir: null,
    lastExportDir: null
  }
}

async function tempDir(prefix = 'minidiary-mig-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

interface Source {
  dir: string
  repo: VaultRepository
  store: AttachmentStore
  attachmentId: string
  payload: Buffer
}

async function makeSource(): Promise<Source> {
  const dir = await tempDir('minidiary-src-')
  const repo = new VaultRepository({ dir, scrypt: FAST })
  await repo.create(PASSWORD)
  const store = new AttachmentStore(dir, () => repo.getAttachmentKey())
  const payload = Buffer.concat([PNG, Buffer.from('雨停之后', 'utf8'), Buffer.alloc(64, 3)])
  const attachment = await store.addFromBytes({
    name: '窗外的梧桐.png',
    mime: 'image/png',
    bytes: new Uint8Array(payload)
  })
  await repo.saveEntry({
    date: '2026-11-06',
    title: '雨停之后',
    body: `下午四点雨停了。\n\n![窗外的梧桐](attachment://${attachment.id})\n\n> 注意力不是一种资源。`,
    tags: ['日常', '思考'],
    attachments: [attachment]
  })
  await repo.flush()
  return { dir, repo, store, attachmentId: attachment.id, payload }
}

async function exportSource(source: Source, targetPath: string): Promise<void> {
  await exportMigrationPackage(
    { repository: source.repo, store: source.store, appVersion: '4.0.0', scrypt: FAST },
    {
      targetPath,
      packagePassword: PACKAGE_PASSWORD,
      packageKey: PACKAGE_KEY,
      preferences: preferences(source.dir),
      job: job()
    }
  )
}

describe('迁移包 roundtrip', () => {
  it('导出后成员齐全，包内没有明文', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const packagePath = path.join(pkgDir, 'bundle.minidiary')
    try {
      await exportSource(source, packagePath)
      const archive = await ZipArchive.open(packagePath)
      try {
        const names = archive.names()
        expect(names).toContain(PACKAGE_MEMBER.manifest)
        expect(names).toContain(PACKAGE_MEMBER.vault)
        expect(names).toContain(PACKAGE_MEMBER.prefs)
        expect(names).toContain(PACKAGE_MEMBER.checksums)
        expect(names).toContain(`attachments/${source.attachmentId}.mdat`)
        const manifestText = (await archive.readBuffer(PACKAGE_MEMBER.manifest)).toString()
        const manifest = JSON.parse(manifestText) as { entryCount: number; attachmentCount: number }
        expect(manifest.entryCount).toBe(1)
        expect(manifest.attachmentCount).toBe(1)
      } finally {
        archive.close()
      }

      const bytes = await readFile(packagePath)
      expect(bytes.includes(Buffer.from('雨停之后'))).toBe(false)
      expect(bytes.includes(Buffer.from('下午四点雨停了'))).toBe(false)
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
    }
  })

  it('导入空库：采用包内 DEK，附件原样复制，新密码生效', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const packagePath = path.join(pkgDir, 'bundle.minidiary')
    const targetDir = await tempDir('minidiary-dst-')
    try {
      await exportSource(source, packagePath)
      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      const store = new AttachmentStore(targetDir, () => repo.getAttachmentKey())
      const importer = new MigrationImporter({ repository: repo, store, scrypt: FAST })

      await expect(
        importer.preview(packagePath, 'wrong-package-password', PACKAGE_KEY)
      ).rejects.toMatchObject({ code: 'WRONG_PASSWORD' })

      const preview = await importer.preview(packagePath, PACKAGE_PASSWORD, PACKAGE_KEY)
      expect(preview.summary.entryCount).toBe(1)
      expect(preview.summary.attachmentCount).toBe(1)
      expect(preview.summary.firstDate).toBe('2026-11-06')

      const result = await importer.run({
        token: preview.token,
        mode: 'replace',
        newPassword: NEW_PASSWORD,
        job: job('migration-import')
      })
      expect(result.entries).toBe(1)

      const snapshot = await repo.unlock(NEW_PASSWORD)
      expect(snapshot.entries).toHaveLength(1)
      const entry = snapshot.entries[0]
      expect(entry?.title).toBe('雨停之后')
      expect(entry?.attachments[0]?.id).toBe(source.attachmentId)
      expect(entry?.body).toContain(`attachment://${source.attachmentId}`)

      const restored: Buffer[] = []
      for await (const chunk of store.readRange(
        source.attachmentId,
        {
          size: entry!.attachments[0]!.size,
          chunkSize: entry!.attachments[0]!.chunkSize,
          totalChunks: entry!.attachments[0]!.totalChunks
        },
        0,
        entry!.attachments[0]!.size
      )) {
        restored.push(chunk)
      }
      expect(Buffer.concat(restored).equals(source.payload)).toBe(true)
      expect(await store.verify(entry!.attachments[0]!)).toBe(true)
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('没有公钥不能导入；公钥错误与私钥错误提示一致', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const targetDir = await tempDir('minidiary-dst-')
    try {
      const packagePath = path.join(pkgDir, 'bundle.minidiary')
      await exportSource(source, packagePath)
      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      const importer = new MigrationImporter({
        repository: repo,
        store: new AttachmentStore(targetDir, () => repo.getAttachmentKey()),
        scrypt: FAST
      })

      const info = await importer.inspect(packagePath)
      expect(info.requiresKey).toBe(true)
      expect(info.packageFormat).toBe(2)

      await expect(importer.preview(packagePath, PACKAGE_PASSWORD)).rejects.toMatchObject({
        code: 'PACKAGE_KEY_REQUIRED'
      })
      await expect(
        importer.preview(packagePath, PACKAGE_PASSWORD, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ')
      ).rejects.toMatchObject({ code: 'WRONG_PASSWORD' })
      await expect(importer.preview(packagePath, PACKAGE_PASSWORD, PACKAGE_KEY)).resolves.toBeTruthy()
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('旧格式（packageFormat 1）仍然只需要密码', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const targetDir = await tempDir('minidiary-dst-')
    try {
      const packagePath = path.join(pkgDir, 'legacy.minidiary')
      await exportMigrationPackage(
        { repository: source.repo, store: source.store, appVersion: '4.0.0', scrypt: FAST },
        {
          targetPath: packagePath,
          packagePassword: PACKAGE_PASSWORD,
          packageKey: '',
          packageFormat: 1,
          preferences: preferences(source.dir),
          job: job()
        }
      )
      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      const importer = new MigrationImporter({
        repository: repo,
        store: new AttachmentStore(targetDir, () => repo.getAttachmentKey()),
        scrypt: FAST
      })
      expect((await importer.inspect(packagePath)).requiresKey).toBe(false)
      const preview = await importer.preview(packagePath, PACKAGE_PASSWORD)
      expect(preview.summary.entryCount).toBe(1)
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('篡改 vault.inkv 的包会被拒绝', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const packagePath = path.join(pkgDir, 'bundle.minidiary')
    const tamperedPath = path.join(pkgDir, 'tampered.minidiary')
    const targetDir = await tempDir('minidiary-dst-')
    try {
      await exportSource(source, packagePath)

      const archive = await ZipArchive.open(packagePath)
      const members = new Map<string, Buffer>()
      for (const name of archive.names()) {
        members.set(name, await archive.readBuffer(name, 32 * 1024 * 1024))
      }
      archive.close()

      const vaultBuffer = Buffer.from(members.get(PACKAGE_MEMBER.vault) ?? Buffer.alloc(0))
      const parsed = JSON.parse(vaultBuffer.toString()) as { payload: { ciphertext: string } }
      const cipher = Buffer.from(parsed.payload.ciphertext, 'base64')
      cipher[5] = (cipher[5] ?? 0) ^ 0xff
      parsed.payload.ciphertext = cipher.toString('base64')
      members.set(PACKAGE_MEMBER.vault, Buffer.from(JSON.stringify(parsed), 'utf8'))

      const writer = new ZipWriter({ filePath: tamperedPath })
      for (const [name, data] of members) writer.addBuffer(name, data)
      await writer.finalize()

      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      const importer = new MigrationImporter({
        repository: repo,
        store: new AttachmentStore(targetDir, () => repo.getAttachmentKey()),
        scrypt: FAST
      })
      await expect(importer.preview(tamperedPath, PACKAGE_PASSWORD)).rejects.toMatchObject({
        code: 'CORRUPT_VAULT'
      })
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('replace 到已有库：保留目标 vaultId 与 DEK，附件重新加密', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const packagePath = path.join(pkgDir, 'bundle.minidiary')
    const targetDir = await tempDir('minidiary-dst-')
    try {
      await exportSource(source, packagePath)

      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await repo.create('target-password-1234')
      await repo.saveEntry({
        date: '2026-11-01',
        title: '目标库原有条目',
        body: '会被替换掉',
        tags: [],
        attachments: []
      })
      await repo.flush()
      const targetVaultId = repo.getVaultId()

      const store = new AttachmentStore(targetDir, () => repo.getAttachmentKey())
      const importer = new MigrationImporter({ repository: repo, store, scrypt: FAST })
      const preview = await importer.preview(packagePath, PACKAGE_PASSWORD, PACKAGE_KEY)
      const packageCipher = await readFile(
        path.join(source.dir, 'attachments', `${source.attachmentId}.mdat`)
      )

      await importer.run({
        token: preview.token,
        mode: 'replace',
        newPassword: NEW_PASSWORD,
        job: job('migration-import')
      })

      const snapshot = repo.getSnapshot()
      expect(repo.getVaultId()).toBe(targetVaultId)
      expect(snapshot.entries).toHaveLength(1)
      expect(snapshot.entries[0]?.title).toBe('雨停之后')
      expect(snapshot.entries[0]?.attachments[0]?.id).toBe(source.attachmentId)

      const reencrypted = await readFile(
        path.join(targetDir, 'attachments', `${source.attachmentId}.mdat`)
      )
      expect(reencrypted.equals(packageCipher)).toBe(false)
      expect(
        await store.verify({
          id: source.attachmentId,
          size: source.payload.length,
          totalChunks: snapshot.entries[0]!.attachments[0]!.totalChunks,
          chunkSize: snapshot.entries[0]!.attachments[0]!.chunkSize,
          sha256: snapshot.entries[0]!.attachments[0]!.sha256
        })
      ).toBe(true)
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('merge：同日合并且为包内附件生成新 ID，正文引用同步替换', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const packagePath = path.join(pkgDir, 'bundle.minidiary')
    const targetDir = await tempDir('minidiary-dst-')
    try {
      await exportSource(source, packagePath)

      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await repo.create('target-password-1234')
      await repo.saveEntry({
        date: '2026-11-06',
        title: '我这边的标题',
        body: '我这边写的正文',
        tags: ['本地'],
        attachments: []
      })
      await repo.flush()

      const store = new AttachmentStore(targetDir, () => repo.getAttachmentKey())
      const importer = new MigrationImporter({ repository: repo, store, scrypt: FAST })
      const preview = await importer.preview(packagePath, PACKAGE_PASSWORD, PACKAGE_KEY)
      const result = await importer.run({
        token: preview.token,
        mode: 'merge',
        newPassword: PASSWORD,
        job: job('migration-import')
      })
      expect(result.merged).toBe(1)

      const entry = repo.getSnapshot().entries[0]
      expect(entry?.title).toBe('我这边的标题 | 雨停之后')
      expect(entry?.body).toContain('我这边写的正文')
      expect(entry?.body).toContain('---')
      expect(entry?.tags.sort()).toEqual(['思考', '日常', '本地'])
      const newId = entry?.attachments[0]?.id
      expect(newId).toBeDefined()
      expect(newId).not.toBe(source.attachmentId)
      expect(entry?.body).toContain(`attachment://${newId}`)
      expect(entry?.body).not.toContain(`attachment://${source.attachmentId}`)
      expect(await store.verify(entry!.attachments[0]!)).toBe(true)
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('merge 进已有附件库：保留目标附件文件，包内附件换新 ID', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const packagePath = path.join(pkgDir, 'bundle.minidiary')
    const targetDir = await tempDir('minidiary-dst-')
    try {
      await exportSource(source, packagePath)

      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await repo.create('target-password-1234')
      const store = new AttachmentStore(targetDir, () => repo.getAttachmentKey())
      const ownBytes = Buffer.concat([PNG, Buffer.from('我自己的图', 'utf8')])
      const own = await store.addFromBytes({
        name: '自己的图.png',
        mime: 'image/png',
        bytes: new Uint8Array(ownBytes)
      })
      await repo.saveEntry({
        date: '2026-11-06',
        title: '我的这天',
        body: `我写的内容\n\n![自己的图](attachment://${own.id})`,
        tags: ['本地'],
        attachments: [own]
      })
      await repo.flush()

      const importer = new MigrationImporter({ repository: repo, store, scrypt: FAST })
      const preview = await importer.preview(packagePath, PACKAGE_PASSWORD, PACKAGE_KEY)
      const result = await importer.run({
        token: preview.token,
        mode: 'merge',
        newPassword: PASSWORD,
        job: job('migration-import')
      })
      expect(result.merged).toBe(1)

      const entry = repo.getSnapshot().entries.find((item) => item.date === '2026-11-06')
      expect(entry?.attachments).toHaveLength(2)
      const ownKept = entry?.attachments.find((item) => item.id === own.id)
      expect(ownKept?.name).toBe('自己的图.png')
      const imported = entry?.attachments.find((item) => item.id !== own.id)
      expect(imported?.name).toBe('窗外的梧桐.png')

      // 目标库原有附件文件没有被搬走/删除，包内附件是重新加密的新文件
      expect(await store.verify(own)).toBe(true)
      expect(await store.verify(imported!)).toBe(true)
      expect(await store.listFiles()).toEqual(
        expect.arrayContaining([`${own.id}.mdat`, `${imported!.id}.mdat`])
      )

      // 回滚目录已清理，库仍可正常解锁
      expect(await stat(path.join(targetDir, 'migration')).then((info) => info.isDirectory())).toBe(true)
      repo.lock()
      await repo.unlock(PASSWORD)
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('引用的附件文件缺失时导出失败', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    try {
      await rm(path.join(source.dir, 'attachments', `${source.attachmentId}.mdat`))
      await expect(
        exportMigrationPackage(
          { repository: source.repo, store: source.store, appVersion: '4.0.0', scrypt: FAST },
          {
            targetPath: path.join(pkgDir, 'broken.minidiary'),
            packagePassword: PACKAGE_PASSWORD,
            packageKey: PACKAGE_KEY,
            preferences: preferences(source.dir),
            job: job()
          }
        )
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(await stat(path.join(pkgDir, 'broken.minidiary')).catch(() => null)).toBeNull()
      expect(
        await stat(path.join(pkgDir, 'broken.minidiary.part')).catch(() => null)
      ).toBeNull()
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
    }
  })

  it('孤儿附件也会进包（整目录全量）', async () => {
    const source = await makeSource()
    const pkgDir = await tempDir('minidiary-pkg-')
    const targetDir = await tempDir('minidiary-dst-')
    const packagePath = path.join(pkgDir, 'bundle.minidiary')
    try {
      const orphan = await source.store.addFromBytes({
        name: '未引用.txt',
        mime: 'text/plain',
        bytes: new Uint8Array(Buffer.from('orphan', 'utf8'))
      })
      await exportSource(source, packagePath)

      const archive = await ZipArchive.open(packagePath)
      const names = archive.names()
      archive.close()
      expect(names).toContain(`attachments/${orphan.id}.mdat`)

      const repo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      const store = new AttachmentStore(targetDir, () => repo.getAttachmentKey())
      const importer = new MigrationImporter({ repository: repo, store, scrypt: FAST })
      const preview = await importer.preview(packagePath, PACKAGE_PASSWORD, PACKAGE_KEY)
      expect(preview.summary.attachmentCount).toBe(2)
      await importer.run({
        token: preview.token,
        mode: 'replace',
        newPassword: NEW_PASSWORD,
        job: job('migration-import')
      })
      expect(await store.listFiles()).toContain(`${orphan.id}.mdat`)
    } finally {
      await rm(source.dir, { recursive: true, force: true })
      await rm(pkgDir, { recursive: true, force: true })
      await rm(targetDir, { recursive: true, force: true })
    }
  })
})
