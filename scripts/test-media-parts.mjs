/**
 * Unit checks for shared multimodal mediaParts helpers.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mediaUrl = pathToFileURL(path.join(root, 'src/main/proxy/utils/mediaParts.ts')).href
const mod = await import(mediaUrl)

const {
  extractMediaParts,
  mimeFromDataUrl,
  classifyMime,
  inlineTextFilesAsPrompt,
  buildFallbackMediaPrompt,
  isDataUrl,
} = mod

assert.equal(isDataUrl('data:image/png;base64,aaa'), true)
assert.equal(mimeFromDataUrl('data:image/jpeg;base64,xx'), 'image/jpeg')
assert.equal(classifyMime('image/png'), 'image')
assert.equal(classifyMime('application/pdf'), 'file')

const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
const parts = extractMediaParts([
  {
    role: 'user',
    content: [
      { type: 'text', text: 'see this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } },
      { type: 'file', file_url: { url: 'data:text/plain;base64,' + Buffer.from('hello file').toString('base64') } },
    ],
  },
])
assert.equal(parts.length, 2)
assert.equal(parts[0].kind, 'image')
assert.equal(parts[1].kind, 'file')

const textMedia = [{
  buffer: Buffer.from('line1\nline2'),
  filename: 'note.txt',
  mimeType: 'text/plain',
  size: 11,
  kind: 'file',
  sourceUrl: 'data:',
}]
const appendix = inlineTextFilesAsPrompt(textMedia)
assert.match(appendix, /FILE: note\.txt/)
assert.match(appendix, /line1/)

const fallback = buildFallbackMediaPrompt([
  ...textMedia,
  {
    buffer: Buffer.from([1, 2, 3]),
    filename: 'tiny.png',
    mimeType: 'image/png',
    size: 3,
    kind: 'image',
    sourceUrl: 'data:',
  },
])
assert.match(fallback, /note\.txt/)
assert.match(fallback, /data:image\/png;base64,/)

console.log('test-media-parts: ok')
