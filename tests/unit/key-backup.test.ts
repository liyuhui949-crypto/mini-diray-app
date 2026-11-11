import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  createKeyBackup,
  openKeyBackup,
  parseKeyBackup
} from '../../src/main/vault/keyBackup'

const VAULT_ID = '11111111-1111-4111-8111-111111111111'
const PASSWORD = 'backup-password-1234'

describe('key backup', () => {
  it('备份文件不含明文 DEK；正确密码可解，错误密码不行', async () => {
    const dek = randomBytes(32)
    const backup = await createKeyBackup({
      vaultId: VAULT_ID,
      dek,
      password: PASSWORD,
      sync: { repo: 'https://github.com/owner/repo.git', branch: 'main' }
    })
    const text = JSON.stringify(backup)
    expect(text).not.toContain(dek.toString('hex'))
    expect(text).not.toContain('github.com/owner/repo')

    const parsed = parseKeyBackup(text)
    const opened = await openKeyBackup(parsed, PASSWORD)
    expect(opened.dek.equals(dek)).toBe(true)
    expect(opened.sync).toEqual({
      repo: 'https://github.com/owner/repo.git',
      branch: 'main'
    })
    await expect(openKeyBackup(parsed, 'wrong-password')).rejects.toMatchObject({
      code: 'WRONG_PASSWORD'
    })
  })

  it('拒绝损坏的文件', () => {
    expect(() => parseKeyBackup('not-json')).toThrowError(/恢复密钥/)
  })
})
