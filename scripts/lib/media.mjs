// 生成演示用的图片 / 音频 / 归档文件（无第三方依赖，结果可复现）
import { deflateSync } from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

import yazl from 'yazl'

// ───────────────────────── PNG ─────────────────────────

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** 抽象照片：渐变底 + 两三个光斑 + 暗角 + 颗粒 */
export function writePhotoPng(filePath, { width = 1200, height = 800, hue = 150, seed = 1 } = {}) {
  const random = mulberry32(seed)
  const base = hslToRgb(hue, 0.34, 0.52)
  const deep = hslToRgb(hue + 26, 0.4, 0.26)
  const light = hslToRgb(hue - 28, 0.28, 0.78)

  const blobs = Array.from({ length: 3 }, () => ({
    x: random() * width,
    y: random() * height,
    r: (0.35 + random() * 0.4) * width,
    strength: 0.35 + random() * 0.35,
    color: random() > 0.5 ? light : base
  }))

  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const t = y / height
      let r = deep[0] + (base[0] - deep[0]) * t
      let g = deep[1] + (base[1] - deep[1]) * t
      let b = deep[2] + (base[2] - deep[2]) * t

      for (const blob of blobs) {
        const distance = Math.hypot(x - blob.x, y - blob.y) / blob.r
        if (distance < 1) {
          const weight = (1 - distance) ** 2 * blob.strength
          r += (blob.color[0] - r) * weight
          g += (blob.color[1] - g) * weight
          b += (blob.color[2] - b) * weight
        }
      }

      const cx = (x / width - 0.5) * 2
      const cy = (y / height - 0.5) * 2
      const vignette = 1 - 0.32 * Math.min(1, Math.hypot(cx, cy) ** 1.6)
      const grain = (random() - 0.5) * 10

      const offset = rowStart + 1 + x * 4
      raw[offset] = Math.max(0, Math.min(255, Math.round((r + grain) * vignette)))
      raw[offset + 1] = Math.max(0, Math.min(255, Math.round((g + grain) * vignette)))
      raw[offset + 2] = Math.max(0, Math.min(255, Math.round((b + grain) * vignette)))
      raw[offset + 3] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
  return import('node:fs/promises').then((fs) => fs.writeFile(filePath, png))
}

// ───────────────────────── WAV（雨声） ─────────────────────────

/** 低通白噪声 + 慢速起伏，听感接近远处的雨 */
export function writeRainWav(filePath, { seconds = 8, sampleRate = 44100 } = {}) {
  const frames = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(frames * 2 * 2)
  const random = mulberry32(20261106)
  let lowL = 0
  let lowR = 0

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate
    const swell = 0.55 + 0.45 * Math.sin((2 * Math.PI * t) / 7.3)
    const patter = 0.85 + 0.15 * Math.sin((2 * Math.PI * t) / 0.37)

    lowL = lowL * 0.86 + (random() * 2 - 1) * 0.14
    lowR = lowR * 0.86 + (random() * 2 - 1) * 0.14
    const hissL = (random() * 2 - 1) * 0.12
    const hissR = (random() * 2 - 1) * 0.12

    const envelope = swell * patter * 0.42
    const left = Math.max(-1, Math.min(1, (lowL * 1.7 + hissL) * envelope))
    const right = Math.max(-1, Math.min(1, (lowR * 1.7 + hissR) * envelope))

    const offset = i * 4
    data.writeInt16LE(Math.round(left * 32767), offset)
    data.writeInt16LE(Math.round(right * 32767), offset + 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)

  return import('node:fs/promises').then((fs) => fs.writeFile(filePath, Buffer.concat([header, data])))
}

// ───────────────────────── ZIP（大文件附件） ─────────────────────────

/** 生成一个可解压的大 ZIP（内部是一个 32MB 的二进制 + 一份说明） */
export async function writeArchiveZip(filePath, { megabytes = 30 } = {}) {
  const zip = new yazl.ZipFile()
  const output = createWriteStream(filePath)
  const done = pipeline(zip.outputStream, output)

  zip.addBuffer(
    Buffer.from('这是演示用的归档附件，用来测试大文件附件的加密写入与迁移吞吐。\n', 'utf8'),
    '说明.txt',
    { compress: true }
  )

  const random = mulberry32(42)
  const block = Buffer.alloc(1024 * 1024)
  let remaining = megabytes
  const generator = async function* () {
    while (remaining > 0) {
      for (let i = 0; i < block.length; i += 4) {
        block.writeUInt32LE(Math.floor(random() * 0xffffffff), i)
      }
      yield block
      remaining -= 1
    }
  }
  zip.addReadStream(Readable.from(generator()), '季度数据.bin', { compress: false })
  zip.end()
  await done
}

export { mulberry32 }
