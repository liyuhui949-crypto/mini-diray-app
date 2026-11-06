import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ZipArchive,
  ZipWriter,
  assertSafeMemberName,
  createHashCounter,
  sha256File
} from '../../src/main/core/zip'
import {
  formatChecksums,
  isAllowedPackageMember,
  attachmentMember,
  attachmentIdFromMember,
  parseChecksums,
  defaultPackageFileName,
  parseManifest
} from '../../src/main/migration/package'

describe('ZIP64 流式读写', () => {
  let dir = ''
  let zipPath = ''

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'minidiary-zip-'))
    zipPath = path.join(dir, 'pkg.zip')
    const sourcePath = path.join(dir, 'payload.bin')
    const payload = Buffer.alloc(4096, 7)
    await writeFile(sourcePath, payload)

    const writer = new ZipWriter({ filePath: zipPath })
    writer.addBuffer('manifest.json', JSON.stringify({ ok: true }))
    const counter = writer.addFileFromDisk(sourcePath, 'attachments/payload.bin')
    const done = new Promise<void>((resolve) => counter.stream.once('end', () => resolve()))
    writer.addStream(
      (async function* () {
        yield Buffer.from('a')
        yield Buffer.from('b')
      })(),
      'checksums.sha256',
      true
    )
    await writer.finalize()
    await done
    expect(counter.bytes()).toBe(4096)
    expect(counter.digest()).toMatch(/^[0-9a-f]{64}$/)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('可以按成员读出内容与大小', async () => {
    const archive = await ZipArchive.open(zipPath)
    try {
      expect(archive.names().sort()).toEqual([
        'attachments/payload.bin',
        'checksums.sha256',
        'manifest.json'
      ])
      expect(JSON.parse((await archive.readBuffer('manifest.json')).toString())).toEqual({ ok: true })
      expect((await archive.readBuffer('checksums.sha256')).toString()).toBe('ab')
      expect(archive.info('attachments/payload.bin')?.size).toBe(4096)
      const stream = await archive.openStream('attachments/payload.bin')
      const chunks: Buffer[] = []
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk)
      expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(4096, 7))
    } finally {
      archive.close()
    }
  })

  it('成员白名单拒绝未知文件', async () => {
    await expect(ZipArchive.open(zipPath, { allowMember: isAllowedPackageMember })).rejects.toThrow(
      /不允许的文件/
    )
  })

  it('拒绝路径穿越、绝对路径、盘符与反斜杠', () => {
    expect(() => assertSafeMemberName('../evil.mdat')).toThrow(/路径穿越/)
    expect(() => assertSafeMemberName('a/../../evil')).toThrow(/路径穿越/)
    expect(() => assertSafeMemberName('/etc/passwd')).toThrow(/绝对路径/)
    expect(() => assertSafeMemberName('C:/windows')).toThrow(/盘符/)
    expect(() => assertSafeMemberName('a\\b')).toThrow(/反斜杠/)
    expect(() => assertSafeMemberName('')).toThrow()
    expect(() => assertSafeMemberName('attachments/1234.mdat')).not.toThrow()
  })

  it('SHA-256 计数器与文件哈希一致', async () => {
    const counter = createHashCounter()
    const consumed = new Promise<void>((resolve) => counter.stream.once('end', () => resolve()))
    counter.stream.resume()
    counter.stream.end(Buffer.from('hello'))
    await consumed
    expect(counter.digest()).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
    const sourcePath = path.join(dir, 'payload.bin')
    expect(await sha256File(sourcePath)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('迁移包清单与校验文件', () => {
  it('成员白名单只接受清单里的文件名', () => {
    expect(isAllowedPackageMember('manifest.json')).toBe(true)
    expect(isAllowedPackageMember('vault.inkv')).toBe(true)
    expect(isAllowedPackageMember('prefs.json')).toBe(true)
    expect(isAllowedPackageMember('checksums.sha256')).toBe(true)
    expect(isAllowedPackageMember('attachments/6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e.mdat')).toBe(true)
    expect(isAllowedPackageMember('attachments/not-a-uuid.mdat')).toBe(false)
    expect(isAllowedPackageMember('logs.txt')).toBe(false)
  })

  it('checksums 与 sha256sum 格式互通', () => {
    const text = formatChecksums([
      { member: 'vault.inkv', sha256: 'a'.repeat(64) },
      { member: 'manifest.json', sha256: 'b'.repeat(64) }
    ])
    const parsed = parseChecksums(text)
    expect(parsed.get('vault.inkv')).toBe('a'.repeat(64))
    expect(parsed.get('manifest.json')).toBe('b'.repeat(64))
    expect(parseChecksums('garbage line').size).toBe(0)
  })

  it('附件成员名与 ID 互转', () => {
    const id = '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e'
    expect(attachmentMember(id)).toBe(`attachments/${id}.mdat`)
    expect(attachmentIdFromMember(`attachments/${id}.mdat`)).toBe(id)
    expect(attachmentIdFromMember('attachments/x.mdat')).toBeNull()
  })

  it('默认文件名为中文并带日期', () => {
    expect(defaultPackageFileName(new Date(2026, 10, 6))).toBe(
      'Mini Diary 迁移包 2026-11-06.minidiary'
    )
  })

  it('拒绝缺少字段或版本过新的清单', () => {
    const manifest = {
      packageFormat: 1,
      appVersion: '4.0.0',
      createdAt: '2026-11-06T00:00:00.000Z',
      formatVersion: 1,
      schemaVersion: 1,
      vaultId: '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e',
      entryCount: 1,
      attachmentCount: 0,
      totalAttachmentBytes: 0,
      firstDate: '2026-11-06',
      lastDate: '2026-11-06',
      hasPreferences: true
    }
    expect(parseManifest(JSON.stringify(manifest)).entryCount).toBe(1)
    // 旧格式（1）仍然可以读，用来导入历史包
    expect(parseManifest(JSON.stringify({ ...manifest, packageFormat: 1 })).packageFormat).toBe(1)
    expect(() => parseManifest(JSON.stringify({ ...manifest, packageFormat: 99 }))).toThrow(
      /更新的版本/
    )
    expect(() => parseManifest('{}')).toThrow()
    expect(() => parseManifest('not json')).toThrow()
  })
})
