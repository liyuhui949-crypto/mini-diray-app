import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'

import { AppError } from '@shared/errors'
import { composePackageSecret, isValidPackageKey } from '@shared/packageKey'
import type { Attachment } from '@shared/types'

import { ZipArchive, ZipWriter } from '../core/zip'
import { deriveFileKey, parseHeader, verifyHeaderTag } from '../attachments/format'
import { formatChecksums, parseChecksums } from '../migration/package'
import { encryptGcm, decryptGcm } from '../vault/crypto'
import { packageKeyEnvelopeSchema } from '../vault/format'
import { pathExists, removePath } from '../vault/paths'
import type { VaultRepository } from '../vault/repository'

const MANIFEST = 'manifest.enc'
const KEY_MEMBER = 'key.enc'
const CHECKSUMS = 'checksums.sha256'
const ATTACHMENT_PREFIX = 'attachments/'
const ATTACHMENT_RE = /^attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.mdat$/i
const MANIFEST_AAD = (vaultId: string): string => `MINIDIARY|inkatt|manifest|1|${vaultId}`

const manifestSchema = z.object({
  format: z.literal('inkatt/2'),
  vaultId: z.string().min(1),
  createdAt: z.string().min(1),
  items: z.array(
    z.object({
      id: z.string().regex(/^[0-9a-f-]{36}$/i),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/i)
    })
  )
})

type Manifest = z.infer<typeof manifestSchema>

interface AttachmentPackageSecret {
  packageKey: string
  packagePassword: string
}

function packageSecret(input: AttachmentPackageSecret): string {
  if (!isValidPackageKey(input.packageKey)) {
    throw new AppError('INVALID_INPUT', '公钥不合法')
  }
  if (input.packagePassword.length < 8) {
    throw new AppError('INVALID_INPUT', '私钥至少 8 位')
  }
  return composePackageSecret(input.packageKey, input.packagePassword)
}

function attachmentPath(dir: string, id: string): string {
  return path.join(dir, `${id}.mdat`)
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function defaultName(): string {
  const now = new Date()
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
  return `Mini Diary 附件包 ${date}.inkatt`
}

export async function exportAttachmentPackage(
  repository: VaultRepository,
  attachmentsDir: string,
  parent: BrowserWindow | null,
  secretInput: AttachmentPackageSecret
): Promise<{ path: string | null; count: number; bytes: number }> {
  if (!repository.isUnlocked) throw new AppError('VAULT_LOCKED')
  const secret = packageSecret(secretInput)
  const snapshot = repository.getSnapshot()
  const byId = new Map<string, Attachment>()
  for (const entry of snapshot.entries) {
    for (const attachment of entry.attachments) byId.set(attachment.id, attachment)
  }

  const items: Array<{ id: string; size: number; sha256: string; file: string }> = []
  for (const attachment of byId.values()) {
    const file = attachmentPath(attachmentsDir, attachment.id)
    if (!(await pathExists(file))) continue
    items.push({ id: attachment.id, size: attachment.size, sha256: attachment.sha256, file })
  }
  if (items.length === 0) throw new AppError('ATTACHMENT_PACKAGE_INVALID', '没有可导出的附件')

  const owner = parent ?? BrowserWindow.getFocusedWindow()
  const dialogOptions = {
    title: '导出附件包',
    defaultPath: defaultName(),
    filters: [{ name: 'Mini Diary 附件包', extensions: ['inkatt'] }]
  }
  const result = owner
    ? await dialog.showSaveDialog(owner, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (result.canceled || !result.filePath) return { path: null, count: 0, bytes: 0 }
  const target = result.filePath.toLowerCase().endsWith('.inkatt')
    ? result.filePath
    : `${result.filePath}.inkatt`
  const part = `${target}.part`
  const writer = new ZipWriter({ filePath: part })
  const checksums: Array<{ member: string; sha256: string }> = []

  try {
    const { keyEnvelope, manifestKey } = await repository.createAttachmentPackageKey(secret)
    const manifest: Manifest = {
      format: 'inkatt/2',
      vaultId: repository.getVaultId(),
      createdAt: new Date().toISOString(),
      items: items.map(({ id, size, sha256 }) => ({ id, size, sha256 }))
    }
    let manifestBlock: unknown
    try {
      manifestBlock = encryptGcm(
        manifestKey,
        Buffer.from(JSON.stringify(manifest), 'utf8'),
        MANIFEST_AAD(manifest.vaultId)
      )
    } finally {
      manifestKey.fill(0)
    }
    const keyText = JSON.stringify(keyEnvelope)
    const manifestText = JSON.stringify(manifestBlock)
    writer.addBuffer(KEY_MEMBER, keyText)
    writer.addBuffer(MANIFEST, manifestText)
    checksums.push({ member: KEY_MEMBER, sha256: createHash('sha256').update(keyText).digest('hex') })
    checksums.push({
      member: MANIFEST,
      sha256: createHash('sha256').update(manifestText).digest('hex')
    })

    let bytes = 0
    const pending: Array<Promise<void>> = []
    for (const item of items) {
      const member = `${ATTACHMENT_PREFIX}${item.id}.mdat`
      const counter = writer.addFileFromDisk(item.file, member)
      bytes += item.size
      pending.push(
        new Promise<void>((resolve, reject) => {
          counter.stream.once('end', () => {
            checksums.push({ member, sha256: counter.digest() })
            resolve()
          })
          counter.stream.once('error', () => reject(new AppError('IO_ERROR', '读取附件失败')))
        })
      )
    }
    const checksumStream = new PassThrough()
    writer.addStream(checksumStream, CHECKSUMS, true)
    await Promise.all(pending)
    checksumStream.end(formatChecksums(checksums))
    await writer.finalize()
    await fs.rename(part, target)
    await fs.chmod(target, 0o600).catch(() => undefined)
    return { path: target, count: items.length, bytes }
  } catch (error) {
    writer.abort()
    await removePath(part).catch(() => undefined)
    throw error
  }
}

export async function importAttachmentPackage(
  repository: VaultRepository,
  attachmentsDir: string,
  parent: BrowserWindow | null,
  secretInput: AttachmentPackageSecret
): Promise<{ imported: number; skipped: number }> {
  if (!repository.isUnlocked) throw new AppError('VAULT_LOCKED')
  const secret = packageSecret(secretInput)
  const owner = parent ?? BrowserWindow.getFocusedWindow()
  const dialogOptions = {
    title: '导入附件包',
    properties: ['openFile' as const],
    filters: [{ name: 'Mini Diary 附件包', extensions: ['inkatt'] }]
  }
  const picked = owner
    ? await dialog.showOpenDialog(owner, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  const filePath = picked.filePaths[0]
  if (picked.canceled || !filePath) return { imported: 0, skipped: 0 }

  const archive = await ZipArchive.open(filePath, {
    allowMember: (name) =>
      name === KEY_MEMBER ||
      name === MANIFEST ||
      name === CHECKSUMS ||
      (ATTACHMENT_RE.test(name) && Boolean((name.match(ATTACHMENT_RE) ?? [])[1]))
  })
  try {
    const names = archive.names()
    if (names[names.length - 1] !== CHECKSUMS) {
      throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件包校验文件不在末尾')
    }
    const keyText = (await archive.readBuffer(KEY_MEMBER, 4 * 1024 * 1024)).toString('utf8')
    const manifestText = (await archive.readBuffer(MANIFEST, 16 * 1024 * 1024)).toString('utf8')
    const checksums = parseChecksums(
      (await archive.readBuffer(CHECKSUMS, 4 * 1024 * 1024)).toString('utf8')
    )
    if (
      createHash('sha256').update(keyText).digest('hex') !== checksums.get(KEY_MEMBER) ||
      createHash('sha256').update(manifestText).digest('hex') !== checksums.get(MANIFEST)
    ) {
      throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件包关键文件校验失败')
    }

    let keyEnvelope: z.infer<typeof packageKeyEnvelopeSchema>
    try {
      keyEnvelope = packageKeyEnvelopeSchema.parse(JSON.parse(keyText))
    } catch {
      throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件包密钥文件不合法')
    }

    let manifestKey: Buffer
    try {
      manifestKey = await repository.openAttachmentPackageKey(keyEnvelope, secret)
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'WRONG_PASSWORD') {
          throw new AppError('WRONG_PASSWORD', '公钥或私钥不正确')
        }
        throw error
      }
      throw new AppError('WRONG_PASSWORD', '公钥或私钥不正确')
    }

    let manifest: Manifest
    try {
      const block = JSON.parse(manifestText) as {
        alg: 'AES-256-GCM'
        iv: string
        ciphertext: string
        tag: string
      }
      const plaintext = decryptGcm(
        manifestKey,
        block,
        MANIFEST_AAD(keyEnvelope.vaultId)
      )
      const parsed = manifestSchema.safeParse(JSON.parse(plaintext.toString('utf8')))
      if (!parsed.success) throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件包清单不合法')
      manifest = parsed.data
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'WRONG_PASSWORD') {
          throw new AppError('WRONG_PASSWORD', '公钥或私钥不正确')
        }
        throw error
      }
      throw new AppError('WRONG_PASSWORD', '公钥或私钥不正确')
    } finally {
      manifestKey.fill(0)
    }
    if (manifest.vaultId !== repository.getVaultId() || keyEnvelope.vaultId !== manifest.vaultId) {
      throw new AppError('SYNC_VAULT_MISMATCH')
    }

    await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 })
    const attachmentKey = repository.getAttachmentKey()
    let imported = 0
    let skipped = 0

    for (const item of manifest.items) {
      const member = `${ATTACHMENT_PREFIX}${item.id}.mdat`
      const target = attachmentPath(attachmentsDir, item.id)
      const expected = checksums.get(member)
      if (!expected) throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件包缺少校验值')

      if (await pathExists(target)) {
        if ((await sha256File(target)) === expected) {
          skipped += 1
          continue
        }
        throw new AppError('ATTACHMENT_PACKAGE_INVALID', '本机已有同 ID 但内容不同的附件')
      }

      const stream = await archive.openStream(member)
      const part = `${target}.import-part`
      const hash = createHash('sha256')
      const handle = await fs.open(part, 'w', 0o600)
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          hash.update(chunk)
          await handle.write(chunk)
        }
      } finally {
        await handle.close()
      }
      if (hash.digest('hex') !== expected) {
        await removePath(part).catch(() => undefined)
        throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件包内容校验失败')
      }

      const handleHead = await fs.open(part, 'r')
      let headBuffer: Buffer
      try {
        const buffer = Buffer.alloc(64)
        await handleHead.read(buffer, 0, 64, 0)
        headBuffer = buffer
      } finally {
        await handleHead.close()
      }
      const header = parseHeader(headBuffer)
      const fileKey = deriveFileKey(attachmentKey, header.fileId)
      if (header.fileId.toString('hex') !== item.id.replace(/-/g, '').toLowerCase()) {
        await removePath(part).catch(() => undefined)
        throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件 ID 与文件头不一致')
      }
      if (header.plaintextSize !== item.size) {
        await removePath(part).catch(() => undefined)
        throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件大小与包清单不一致')
      }
      if (!verifyHeaderTag(headBuffer, fileKey)) {
        await removePath(part).catch(() => undefined)
        throw new AppError('ATTACHMENT_PACKAGE_INVALID', '附件头校验失败')
      }
      await fs.rename(part, target)
      await fs.chmod(target, 0o600).catch(() => undefined)
      imported += 1
    }

    return { imported, skipped }
  } finally {
    archive.close()
  }
}
