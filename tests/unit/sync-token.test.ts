import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { SyncSecrets } from '../../src/main/sync/secrets'

const VAULT_ID = '11111111-1111-4111-8111-111111111111'

async function tempDir(prefix = 'minidiary-token-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

describe('SyncSecrets', () => {
  it('用 vault 密钥加密，文件里没有明文 token；错密钥读不出', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'sync-token.bin')
      const key = randomBytes(32)
      const secrets = new SyncSecrets(file)
      await secrets.set('ghp_test_token_1234567890', key, VAULT_ID)

      const raw = await readFile(file, 'utf8')
      expect(raw.includes('ghp_test_token')).toBe(false)
      await expect(secrets.get(key, VAULT_ID)).resolves.toBe('ghp_test_token_1234567890')
      await expect(secrets.get(randomBytes(32), VAULT_ID)).resolves.toBeNull()
      await expect(secrets.get(key, '22222222-2222-4222-8222-222222222222')).resolves.toBeNull()
      expect(await secrets.has()).toBe(true)
      await secrets.clear()
      expect(await secrets.has()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
