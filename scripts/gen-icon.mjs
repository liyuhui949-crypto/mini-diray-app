// 生成 1024×1024 的 PNG 图标（无第三方依赖：手写 PNG 编码）
// 图形：米白底 + 深绿圆角"书页" + 一条装订线与一个点，呼应应用气质。
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const SIZE = 1024
const px = Buffer.alloc(SIZE * SIZE * 4)

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a
}

function mix(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t)
  ]
}

function insideRounded(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius)
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 || (x >= x0 + radius && x <= x1 - radius) || (y >= y0 + radius && y <= y1 - radius)
}

const bgTop = [251, 251, 250]
const bgBottom = [236, 235, 230]
const accent = [47, 111, 78]
const accentSoft = [233, 241, 236]

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 圆角背景
    if (insideRounded(x, y, 0, 0, SIZE - 1, SIZE - 1, 210)) {
      set(x, y, ...mix(bgTop, bgBottom, y / SIZE))
    }
  }
}

// 页面主体（深绿圆角矩形），带一点点留白
for (let y = 210; y < 830; y++) {
  for (let x = 232; x < 792; x++) {
    if (insideRounded(x, y, 232, 210, 792, 830, 64)) {
      set(x, y, ...accent)
    }
  }
}

// 书页上的横线
for (let line = 0; line < 4; line++) {
  const top = 350 + line * 96
  for (let y = top; y < top + 22; y++) {
    for (let x = 320; x < 704 - line * 40; x++) {
      if (insideRounded(x, y, 320, top, 704 - line * 40, top + 22, 11)) {
        set(x, y, ...mix(accentSoft, [255, 255, 255], 0.35))
      }
    }
  }
}

// 装订线
for (let y = 300; y < 760; y++) {
  for (let x = 272; x < 290; x++) {
    set(x, y, 233, 241, 236)
  }
}

// 右下角的圆点（"今天"）
for (let y = 690; y < 762; y++) {
  for (let x = 640; x < 712; x++) {
    if ((x - 676) ** 2 + (y - 726) ** 2 <= 36 ** 2) set(x, y, 233, 241, 236)
  }
}

// 打包成 PNG（RGBA, 8bit, 无滤波）
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

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
  const typeBuffer = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuffer, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('build/icon.png', png.length, 'bytes')
