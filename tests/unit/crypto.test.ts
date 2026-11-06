import { describe, expect, it } from 'vitest'

import { AppError } from '@shared/errors'
import type { VaultData } from '@shared/types'

import {
  KEY_BYTES,
  deriveAttachmentKey,
  derivePayloadKey,
  deriveSubkey,
  randomUuid,
  sha256Hex,
  wipe
} from '../../src/main/vault/crypto'
import {
  type VaultEnvelope,
  createEnvelope,
  createVaultData,
  openEnvelope,
  parseEnvelope,
  payloadAad,
  rewrapEnvelope,
  sealPayload,
  serializeEnvelope
} from '../../src/main/vault/format'

const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'correct horse battery'

function sampleData(): VaultData {
  const data = createVaultData(new Date('2026-11-06T00:00:00.000Z'))
  data.entries.push({
    date: '2026-11-06',
    title: '雨停之后',
    body: '下午四点雨停了。',
    tags: ['日常'],
    attachments: [],
    wordCount: 9,
    createdAt: '2026-11-06T08:00:00.000Z',
    updatedAt: '2026-11-06T08:00:00.000Z'
  })
  return data
}

async function makeEnvelope(password = PASSWORD): Promise<{
  data: VaultData
  envelope: ReturnType<typeof serializeEnvelope>
  dek: Buffer
}> {
  const data = sampleData()
  const { envelope, dek } = await createEnvelope({
    password,
    data,
    scrypt: FAST,
    salt: Buffer.alloc(16, 7)
  })
  return { data, envelope: serializeEnvelope(envelope), dek }
}

describe('vault 加密信封', () => {
  it('正确密码可以解开，内容一致', async () => {
    const { data, envelope } = await makeEnvelope()
    const opened = await openEnvelope(parseEnvelope(envelope), PASSWORD)
    expect(opened.data.vaultId).toBe(data.vaultId)
    expect(opened.data.entries).toHaveLength(1)
    expect(opened.data.entries[0]?.title).toBe('雨停之后')
    wipe(opened.dek)
  })

  it('错误密码失败，且统一报“密码错误或文件已损坏”', async () => {
    const { envelope } = await makeEnvelope()
    await expect(openEnvelope(parseEnvelope(envelope), 'wrong password')).rejects.toMatchObject({
      code: 'WRONG_PASSWORD'
    })
  })

  it('篡改 payload 会失败', async () => {
    const { envelope } = await makeEnvelope()
    const parsed = JSON.parse(envelope) as { payload: { ciphertext: string } }
    const bytes = Buffer.from(parsed.payload.ciphertext, 'base64')
    bytes[3] = (bytes[3] ?? 0) ^ 0xff
    parsed.payload.ciphertext = bytes.toString('base64')
    await expect(openEnvelope(parsed as unknown as VaultEnvelope, PASSWORD)).rejects.toBeInstanceOf(AppError)
  })

  it('篡改 KDF 参数会失败（AAD 绑定了 kdf）', async () => {
    const { envelope } = await makeEnvelope()
    const parsed = JSON.parse(envelope) as { kdf: { N: number } }
    parsed.kdf.N = 2048
    await expect(openEnvelope(parsed as unknown as VaultEnvelope, PASSWORD)).rejects.toMatchObject({
      code: 'WRONG_PASSWORD'
    })
  })

  it('改密码只重包 DEK，payload 密文保持不变', async () => {
    const { envelope } = await makeEnvelope()
    const parsed = parseEnvelope(envelope)
    const opened = await openEnvelope(parsed, PASSWORD)
    const rewrapped = await rewrapEnvelope(parsed, opened.dek, 'new-password-1234', FAST)

    expect(rewrapped.payload.ciphertext).toBe(parsed.payload.ciphertext)
    expect(rewrapped.kdf.salt).not.toBe(parsed.kdf.salt)

    await expect(openEnvelope(rewrapped, PASSWORD)).rejects.toMatchObject({ code: 'WRONG_PASSWORD' })
    const reopened = await openEnvelope(rewrapped, 'new-password-1234')
    expect(reopened.data.entries).toHaveLength(1)
    wipe(opened.dek)
    wipe(reopened.dek)
  })

  it('同一份数据每次写入都用新 IV', async () => {
    const { data } = await makeEnvelope()
    const first = await createEnvelope({ password: PASSWORD, data, scrypt: FAST })
    const second = await createEnvelope({ password: PASSWORD, data, scrypt: FAST })
    expect(first.envelope.payload.iv).not.toBe(second.envelope.payload.iv)
    expect(first.envelope.payload.ciphertext).not.toBe(second.envelope.payload.ciphertext)
  })

  it('未来格式版本被拒绝', async () => {
    const { envelope } = await makeEnvelope()
    const parsed = JSON.parse(envelope) as { formatVersion: number }
    parsed.formatVersion = 99
    expect(() => parseEnvelope(JSON.stringify(parsed))).toThrowError(/更新版本|升级/)
  })

  it('损坏的 JSON 报 CORRUPT_VAULT', () => {
    expect(() => parseEnvelope('not json')).toThrowError(AppError)
  })

  it('sealPayload 复用同一 DEK 更新内容', async () => {
    const { data, envelope, dek } = await makeEnvelope()
    const parsed = parseEnvelope(envelope)
    data.entries[0]!.title = '改过的标题'
    const sealed = sealPayload(parsed, dek, data)
    const opened = await openEnvelope(sealed, PASSWORD)
    expect(opened.data.entries[0]?.title).toBe('改过的标题')
    wipe(opened.dek)
  })

  it('payloadKey 与 attachmentKey 互不相同，且与 vaultId 绑定', () => {
    const dek = Buffer.alloc(KEY_BYTES, 3)
    const payloadKey = derivePayloadKey(dek, 'vault-a')
    const attachmentKey = deriveAttachmentKey(dek, 'vault-a')
    expect(payloadKey.equals(attachmentKey)).toBe(false)
    expect(derivePayloadKey(dek, 'vault-b').equals(payloadKey)).toBe(false)
    expect(payloadAad('vault-a')).toBe('MINIDIARY|payload|1|vault-a')
  })

  it('HKDF 派生维度与摘要稳定', () => {
    const key = Buffer.alloc(32, 1)
    expect(deriveSubkey(key, 'salt', 'info')).toHaveLength(32)
    expect(deriveSubkey(key, 'salt', 'info').equals(deriveSubkey(key, 'salt', 'info'))).toBe(true)
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(randomUuid()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
