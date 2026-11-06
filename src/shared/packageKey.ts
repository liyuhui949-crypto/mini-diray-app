/**
 * 迁移包的"公钥"：由应用随机生成的一串高熵字符，**不会写进包文件，也不会被应用保存**。
 *
 * 目的：包里的 vault 用「公钥 + 用户密码」组合出的口令才解得开，
 * 所以即使整个包被拿走，攻击者既没有公钥也无法离线暴力破解用户密码。
 * 用户密码在界面上叫"私钥"，只有两部分同时正确才能导入。
 */

/** 去掉容易看错的 0 / 1 / I / L / O / U，共 32 个字符 */
export const PACKAGE_KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PACKAGE_KEY_LENGTH = 32
const GROUP_SIZE = 4

/** 32 个字符，每个字符从 30 个符号里均匀抽取（拒绝采样），约 157 bit 熵 */
export function generatePackageKey(): string {
  const limit = Math.floor(256 / PACKAGE_KEY_ALPHABET.length) * PACKAGE_KEY_ALPHABET.length
  let key = ''
  while (key.length < PACKAGE_KEY_LENGTH) {
    const bytes = new Uint8Array(PACKAGE_KEY_LENGTH)
    globalThis.crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      key += PACKAGE_KEY_ALPHABET[byte % PACKAGE_KEY_ALPHABET.length]
      if (key.length === PACKAGE_KEY_LENGTH) break
    }
  }
  return key
}

/** 去掉短横线/空格并转大写；不做"纠错"，避免把不同公钥当成同一个 */
export function normalizePackageKey(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export function isValidPackageKey(input: string): boolean {
  const normalized = normalizePackageKey(input)
  if (normalized.length !== PACKAGE_KEY_LENGTH) return false
  for (const char of normalized) {
    if (!PACKAGE_KEY_ALPHABET.includes(char)) return false
  }
  return true
}

/** 展示与复制都用带短横线的分组形式：XXXX-XXXX-… */
export function formatPackageKey(input: string): string {
  const normalized = normalizePackageKey(input)
  const groups: string[] = []
  for (let index = 0; index < normalized.length; index += GROUP_SIZE) {
    groups.push(normalized.slice(index, index + GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * 组合出真正参与 KDF 的口令。
 * 任意一段错误都会得到完全不同的派生结果，导入时会报"公钥或私钥不正确"。
 */
export function composePackageSecret(packageKey: string, password: string): string {
  return `MINIDIARY|pkgkey-v1|${normalizePackageKey(packageKey)}|${password}`
}
