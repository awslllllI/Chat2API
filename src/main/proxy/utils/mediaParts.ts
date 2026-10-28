/**
 * Shared helpers for OpenAI-compatible multimodal / file parts.
 * Resolves data-URL or remote URL bytes for provider-specific uploaders.
 */

import axios from 'axios'
import path from 'path'
import mime from 'mime-types'
import { randomUUID } from 'crypto'

/** Default max media size (100MB), matching common web provider limits */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024

/** One media/file part extracted from chat messages */
export interface ExtractedMediaPart {
  /** image | file | audio | video */
  kind: 'image' | 'file' | 'audio' | 'video'
  /** Original URL or data: URL */
  url: string
  /** Suggested filename */
  filename: string
  /** MIME type if known from data URL */
  mimeType?: string
}

/** Resolved binary payload ready for upload */
export interface ResolvedMediaBytes {
  buffer: Buffer
  filename: string
  mimeType: string
  size: number
  kind: ExtractedMediaPart['kind']
  sourceUrl: string
}

/**
 * Classify a MIME type into a media kind.
 */
export function classifyMime(mimeType: string): ExtractedMediaPart['kind'] {
  const lower = (mimeType || '').toLowerCase()
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('audio/')) return 'audio'
  if (lower.startsWith('video/')) return 'video'
  return 'file'
}

/**
 * True when the string is a data: URL.
 */
export function isDataUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith('data:')
}

/**
 * Parse MIME from a data URL header.
 */
export function mimeFromDataUrl(url: string): string {
  const match = url.match(/^data:([^;,]+)/)
  return match?.[1] || 'application/octet-stream'
}

/**
 * Strip the data: header and return raw base64 payload.
 */
export function stripDataUrlHeader(url: string): string {
  const idx = url.indexOf(',')
  return idx >= 0 ? url.slice(idx + 1) : url
}

/**
 * Build a stable filename from MIME / URL.
 */
export function guessFilename(url: string, mimeType: string, prefix = 'upload'): string {
  if (!isDataUrl(url)) {
    const base = path.basename(url.split('?')[0] || '')
    if (base && base.includes('.')) return base.slice(0, 180)
  }
  const ext = mime.extension(mimeType) || 'bin'
  return `${prefix}-${randomUUID().slice(0, 8)}.${ext}`
}

/**
 * Extract image_url / file / input_audio / video_url parts from OpenAI-style messages.
 */
export function extractMediaParts(messages: Array<{ content?: any }> | undefined): ExtractedMediaPart[] {
  const parts: ExtractedMediaPart[] = []
  const seen = new Set<string>()

  for (const msg of messages || []) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (!part || typeof part !== 'object') continue
      let url = ''
      let kind: ExtractedMediaPart['kind'] = 'file'
      let mimeType: string | undefined

      if (part.type === 'image_url') {
        const raw = part.image_url
        url = typeof raw === 'string' ? raw : raw?.url || ''
        kind = 'image'
      } else if (part.type === 'image') {
        url = part.image_url?.url || part.url || part.source?.url || ''
        kind = 'image'
      } else if (part.type === 'file' || part.type === 'file_url') {
        url = part.file_url?.url || part.file?.url || part.url || ''
        kind = 'file'
        if (part.file?.filename) {
          mimeType = part.file.mime_type
        }
      } else if (part.type === 'input_audio') {
        url = part.input_audio?.data || part.url || ''
        kind = 'audio'
        mimeType = part.input_audio?.format
          ? `audio/${part.input_audio.format}`
          : undefined
      } else if (part.type === 'video_url' || part.type === 'video') {
        const raw = part.video_url || part.video
        url = typeof raw === 'string' ? raw : raw?.url || ''
        kind = 'video'
      }

      if (!url || seen.has(url)) continue
      seen.add(url)
      if (isDataUrl(url) && !mimeType) mimeType = mimeFromDataUrl(url)
      parts.push({
        kind: mimeType ? classifyMime(mimeType) : kind,
        url,
        filename: part.file?.filename || guessFilename(url, mimeType || 'application/octet-stream'),
        mimeType,
      })
    }
  }

  return parts
}

/**
 * Collect plain text from a message content field.
 */
export function extractTextFromContent(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && p.text)
      .map((p) => String(p.text))
      .join('\n')
  }
  return String(content)
}

/**
 * Resolve a media URL (data: or http(s)) into bytes for upload.
 */
export async function resolveMediaBytes(
  part: ExtractedMediaPart,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<ResolvedMediaBytes> {
  const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? 60_000

  if (isDataUrl(part.url)) {
    const mimeType = part.mimeType || mimeFromDataUrl(part.url)
    const buffer = Buffer.from(stripDataUrlHeader(part.url), 'base64')
    if (buffer.length > maxBytes) {
      throw new Error(`Media exceeds size limit (${maxBytes} bytes)`)
    }
    return {
      buffer,
      filename: part.filename || guessFilename(part.url, mimeType),
      mimeType,
      size: buffer.length,
      kind: classifyMime(mimeType),
      sourceUrl: part.url.slice(0, 64),
    }
  }

  if (!/^https?:\/\//i.test(part.url)) {
    throw new Error('Unsupported media URL scheme (need data: or http(s))')
  }

  const response = await axios.get(part.url, {
    responseType: 'arraybuffer',
    maxContentLength: maxBytes,
    timeout: timeoutMs,
    validateStatus: () => true,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to download media: HTTP ${response.status}`)
  }
  const buffer = Buffer.from(response.data)
  if (buffer.length > maxBytes) {
    throw new Error(`Media exceeds size limit (${maxBytes} bytes)`)
  }
  const headerType = String(response.headers['content-type'] || '').split(';')[0].trim()
  const mimeType = part.mimeType || headerType || mime.lookup(part.filename) || 'application/octet-stream'
  return {
    buffer,
    filename: part.filename || guessFilename(part.url, String(mimeType)),
    mimeType: String(mimeType),
    size: buffer.length,
    kind: classifyMime(String(mimeType)),
    sourceUrl: part.url,
  }
}

/**
 * Resolve all extracted media parts; continues on individual failures when soft=true.
 */
export async function resolveAllMedia(
  parts: ExtractedMediaPart[],
  options: { soft?: boolean; maxBytes?: number } = {}
): Promise<{ ok: ResolvedMediaBytes[]; errors: string[] }> {
  const ok: ResolvedMediaBytes[] = []
  const errors: string[] = []
  for (const part of parts) {
    try {
      ok.push(await resolveMediaBytes(part, options))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${part.filename}: ${msg}`)
      if (!options.soft) throw err
    }
  }
  return { ok, errors }
}

/**
 * Inline small text-like files into a prompt appendix when upload is unavailable.
 */
export function inlineTextFilesAsPrompt(files: ResolvedMediaBytes[]): string {
  const chunks: string[] = []
  for (const file of files) {
    if (file.kind !== 'file') continue
    const isText =
      file.mimeType.startsWith('text/') ||
      /\.(txt|md|json|csv|xml|html|js|ts|py|java|c|cpp|go|rs|yml|yaml|toml|log)$/i.test(file.filename)
    if (!isText || file.size > 512 * 1024) continue
    chunks.push(`\n\n----- FILE: ${file.filename} -----\n${file.buffer.toString('utf8')}\n----- END FILE -----`)
  }
  return chunks.join('')
}

/** Max data-URL image size to embed in text fallback prompts */
export const INLINE_IMAGE_MAX_BYTES = 200 * 1024

/**
 * Build a best-effort prompt appendix when a provider cannot upload media natively.
 * Text files are inlined; small images become markdown data URLs.
 */
export function buildFallbackMediaPrompt(media: ResolvedMediaBytes[]): string {
  const chunks: string[] = []
  const textAppendix = inlineTextFilesAsPrompt(media)
  if (textAppendix) chunks.push(textAppendix)

  for (const item of media) {
    if (item.kind !== 'image') continue
    if (item.size > INLINE_IMAGE_MAX_BYTES) {
      chunks.push(`\n\n[Image "${item.filename}" omitted: ${item.size} bytes exceeds inline limit]`)
      continue
    }
    const b64 = item.buffer.toString('base64')
    chunks.push(`\n\n![${item.filename}](data:${item.mimeType};base64,${b64})`)
  }

  for (const item of media) {
    if (item.kind === 'audio' || item.kind === 'video') {
      chunks.push(`\n\n[${item.kind} "${item.filename}" attached but provider has no upload path; content not inlined]`)
    }
  }

  return chunks.join('')
}

/**
 * Resolve OpenAI media parts and return a prompt appendix for providers without upload.
 */
export async function resolveMediaPromptAppendix(
  messages: Array<{ content?: any }> | undefined,
  options: { soft?: boolean } = { soft: true },
): Promise<{ appendix: string; count: number; errors: string[] }> {
  const parts = extractMediaParts(messages)
  if (!parts.length) return { appendix: '', count: 0, errors: [] }
  const { ok, errors } = await resolveAllMedia(parts, { soft: options.soft !== false })
  return { appendix: buildFallbackMediaPrompt(ok), count: ok.length, errors }
}
