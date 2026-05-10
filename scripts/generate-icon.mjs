import fs from 'node:fs'
import path from 'node:path'

const sizes = [16, 24, 32, 48, 64, 128, 256]
const buildDir = path.resolve('build')
const iconPath = path.join(buildDir, 'icon.ico')

fs.mkdirSync(buildDir, { recursive: true })

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const roundedRect = (x, y, width, height, radius) => {
  const dx = Math.max(Math.abs(x) - (width / 2 - radius), 0)
  const dy = Math.max(Math.abs(y) - (height / 2 - radius), 0)
  return Math.sqrt(dx * dx + dy * dy) - radius
}

const lightning = (x, y) => {
  const s1 = Math.abs(x * 0.75 + y * 0.22) - 0.11
  const s2 = Math.abs(x * 0.5 + y * 1.18 + 0.17) - 0.085
  const s3 = Math.abs(x * 0.52 + y * 1.22 - 0.14) - 0.085
  return Math.max(s1, Math.min(s2, s3))
}

const writeUInt32 = (buffer, offset, value) => buffer.writeUInt32LE(value >>> 0, offset)
const writeInt32 = (buffer, offset, value) => buffer.writeInt32LE(value | 0, offset)

function makeBitmap(size) {
  const width = size
  const height = size
  const pixelData = Buffer.alloc(width * height * 4)
  const center = (size - 1) / 2
  const scale = 2 / size

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const nx = (px - center) * scale
      const ny = (py - center) * scale

      const outer = roundedRect(nx, ny, 1.54, 1.54, 0.25)
      const inner = roundedRect(nx, ny, 1.3, 1.3, 0.2)
      const bolt = lightning(nx, ny)

      let r = 0
      let g = 0
      let b = 0
      let a = 0

      if (outer <= 0) {
        a = 255
        const t = clamp((ny + 0.9) / 1.8, 0, 1)
        r = Math.round(44 + t * 58)
        g = Math.round(18 + t * 34)
        b = Math.round(76 + t * 88)
      }

      if (inner <= 0) {
        r = 23
        g = 16
        b = 36
        a = 255
      }

      if (bolt <= 0.02 && outer <= 0) {
        const glow = clamp(1 - Math.max(bolt, 0) / 0.02, 0, 1)
        r = Math.round(210 + glow * 30)
        g = Math.round(232 + glow * 15)
        b = 255
        a = 255
      }

      const index = (py * width + px) * 4
      pixelData[index] = b
      pixelData[index + 1] = g
      pixelData[index + 2] = r
      pixelData[index + 3] = a
    }
  }

  const maskRowSize = Math.ceil(width / 32) * 4
  const maskData = Buffer.alloc(maskRowSize * height, 0)
  const headerSize = 40
  const bitmapSize = headerSize + pixelData.length + maskData.length
  const bitmap = Buffer.alloc(bitmapSize)

  writeUInt32(bitmap, 0, 40)
  writeInt32(bitmap, 4, width)
  writeInt32(bitmap, 8, height * 2)
  bitmap.writeUInt16LE(1, 12)
  bitmap.writeUInt16LE(32, 14)
  writeUInt32(bitmap, 16, 0)
  writeUInt32(bitmap, 20, pixelData.length)
  writeInt32(bitmap, 24, 2835)
  writeInt32(bitmap, 28, 2835)
  writeUInt32(bitmap, 32, 0)
  writeUInt32(bitmap, 36, 0)

  for (let row = 0; row < height; row += 1) {
    const srcStart = (height - 1 - row) * width * 4
    const dstStart = headerSize + row * width * 4
    pixelData.copy(bitmap, dstStart, srcStart, srcStart + width * 4)
  }

  maskData.copy(bitmap, headerSize + pixelData.length)
  return bitmap
}

const images = sizes.map((size) => ({ size, data: makeBitmap(size) }))
const header = Buffer.alloc(6 + images.length * 16)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)

let offset = header.length
for (const [index, image] of images.entries()) {
  const entryOffset = 6 + index * 16
  header[entryOffset] = image.size === 256 ? 0 : image.size
  header[entryOffset + 1] = image.size === 256 ? 0 : image.size
  header[entryOffset + 2] = 0
  header[entryOffset + 3] = 0
  header.writeUInt16LE(1, entryOffset + 4)
  header.writeUInt16LE(32, entryOffset + 6)
  header.writeUInt32LE(image.data.length, entryOffset + 8)
  header.writeUInt32LE(offset, entryOffset + 12)
  offset += image.data.length
}

const icon = Buffer.concat([header, ...images.map((image) => image.data)])
fs.writeFileSync(iconPath, icon)
console.log(`Icon generated: ${iconPath}`)
