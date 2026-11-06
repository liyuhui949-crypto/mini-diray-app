/**
 * 迁移包的"公钥"：由应用随机生成的一串高熵字符，**不会写进包文件，也不会被应用保存**。
 *
 * 目的：包里的 vault 用「公钥 + 用户密码」组合出的口令才解得开，
 * 所以即使整个包被拿走，攻击者既没有公钥也无法离线暴力破解用户密码。
 * 用户密码在界面上叫"私钥"，只有两部分同时正确才能导入。
 *
 * 公钥是**大小写敏感**的：A 与 a 是不同的字符，导入时必须原样粘贴。
 */

/** 去掉容易看错的 I / O / i / l / o 以及 0 / 1，共 56 个字符 */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghjkmnpqrstuvwxyz'
const DIGITS = '23456789'
export const PACKAGE_KEY_ALPHABET = `${UPPER}${LOWER}${DIGITS}`

/** 当前生成的公钥长度（字符数，约 743 bit 熵） */
export const PACKAGE_KEY_LENGTH = 128
/** 早期版本生成过的 32 位公钥，仍然允许导入，避免旧包打不开 */
export const LEGACY_PACKAGE_KEY_LENGTH = 32
const ACCEPTED_LENGTHS = [PACKAGE_KEY_LENGTH, LEGACY_PACKAGE_KEY_LENGTH]
const GROUP_SIZE = 4

/** 128 个字符，从 56 个符号里均匀抽取（拒绝采样） */
export function generatePackageKey(): string {
  const alphabetSize = PACKAGE_KEY_ALPHABET.length
  const limit = Math.floor(256 / alphabetSize) * alphabetSize
  let key = ''
  while (key.length < PACKAGE_KEY_LENGTH) {
    const bytes = new Uint8Array(PACKAGE_KEY_LENGTH)
    globalThis.crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      key += PACKAGE_KEY_ALPHABET[byte % alphabetSize]
      if (key.length === PACKAGE_KEY_LENGTH) break
    }
  }
  return key
}

/** 去掉短横线/空格等分隔符；**保留大小写** */
export function normalizePackageKey(input: string): string {
  return input.replace(/[^0-9A-Za-z]/g, '')
}

export function isValidPackageKey(input: string): boolean {
  const normalized = normalizePackageKey(input)
  if (!ACCEPTED_LENGTHS.includes(normalized.length)) return false
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
 * 任一字符（包括大小写）不同都会得到完全不同的派生结果，导入时会报"公钥或私钥不正确"。
 */
export function composePackageSecret(packageKey: string, password: string): string {
  return `MINIDIARY|pkgkey-v1|${normalizePackageKey(packageKey)}|${password}`
}
