/**
 * Kimi web file/image upload helpers.
 * Mirrors www.kimi.com: multipart POST /apiv2-files/file/upload, then poll
 * FileService.GetFileParseProgress until SUCCESS/FAILED.
 */

import axios from 'axios'
import FormData from 'form-data'
import type { ResolvedMediaBytes } from '../utils/mediaParts'

/**
 * Encode a Connect unary JSON frame (flags + BE length + UTF-8 body).
 */
function encodeConnectJsonFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}

/** ProcessStatus from kimi.file.v1 */
export const KIMI_PROCESS_STATUS = {
  UNSPECIFIED: 0,
  PENDING: 1,
  PROCESSING: 2,
  SUCCESS: 3,
  FAILED: 4,
} as const

export type KimiUploadedFile = {
  id: string
  status: number
}

/**
 * Read a protobuf varint; returns [value, nextOffset].
 */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result >>> 0, pos]
    shift += 7
    if (shift > 35) throw new Error('Invalid protobuf varint')
  }
  throw new Error('Truncated protobuf varint')
}

/**
 * Walk top-level protobuf fields into a simple list.
 */
function parseProtoFields(
  buf: Buffer,
): Array<{ field: number; wire: number; bytes?: Buffer; int?: number }> {
  const fields: Array<{ field: number; wire: number; bytes?: Buffer; int?: number }> = []
  let offset = 0
  while (offset < buf.length) {
    const [tag, next] = readVarint(buf, offset)
    offset = next
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      const [value, after] = readVarint(buf, offset)
      fields.push({ field, wire, int: value })
      offset = after
    } else if (wire === 2) {
      const [len, after] = readVarint(buf, offset)
      const end = after + len
      if (end > buf.length) throw new Error('Truncated protobuf length-delimited field')
      fields.push({ field, wire, bytes: buf.subarray(after, end) })
      offset = end
    } else if (wire === 5) {
      fields.push({ field, wire, bytes: buf.subarray(offset, offset + 4) })
      offset += 4
    } else if (wire === 1) {
      fields.push({ field, wire, bytes: buf.subarray(offset, offset + 8) })
      offset += 8
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`)
    }
  }
  return fields
}

/**
 * Strip Connect unary envelope when present (flags + BE length + body).
 */
function unwrapConnectBody(raw: Buffer): Buffer {
  if (raw.length < 5) return raw
  const flags = raw[0]
  const len = raw.readUInt32BE(1)
  if ((flags === 0 || flags === 1) && len === raw.length - 5 && len > 0) {
    return raw.subarray(5)
  }
  return raw
}

/**
 * Extract file.id from UploadResponse protobuf (or JSON fallback).
 * UploadResponse { file: File }; File { id = field 1 }.
 */
export function extractKimiUploadFileId(raw: Buffer): string {
  const asText = raw.toString('utf8').trim()
  if (asText.startsWith('{')) {
    try {
      const json = JSON.parse(asText)
      const id = json?.file?.id || json?.fileId || json?.id
      if (typeof id === 'string' && id) return id
    } catch {
      // fall through to protobuf
    }
  }

  const body = unwrapConnectBody(raw)
  const top = parseProtoFields(body)
  const fileMsg = top.find((f) => f.field === 1 && f.bytes)
  if (!fileMsg?.bytes) {
    // Heuristic: first printable length-delimited string that looks like an id
    const heuristic = [...top, ...top.flatMap((f) => (f.bytes ? parseProtoFields(f.bytes) : []))]
      .map((f) => f.bytes?.toString('utf8') || '')
      .find((s) => /^[A-Za-z0-9_-]{8,128}$/.test(s))
    if (heuristic) return heuristic
    throw new Error('Kimi upload response missing file message')
  }

  const fileFields = parseProtoFields(fileMsg.bytes)
  const idField = fileFields.find((f) => f.field === 1 && f.bytes)
  const id = idField?.bytes?.toString('utf8') || ''
  if (!id) throw new Error('Kimi upload response missing file.id')
  return id
}

/**
 * Normalize parse-progress status from Connect JSON (number or enum string).
 */
export function normalizeKimiProcessStatus(status: unknown): number {
  if (typeof status === 'number' && Number.isFinite(status)) return status
  if (typeof status !== 'string') return KIMI_PROCESS_STATUS.UNSPECIFIED
  const upper = status.toUpperCase()
  if (upper.includes('SUCCESS')) return KIMI_PROCESS_STATUS.SUCCESS
  if (upper.includes('FAIL')) return KIMI_PROCESS_STATUS.FAILED
  if (upper.includes('PROCESSING')) return KIMI_PROCESS_STATUS.PROCESSING
  if (upper.includes('PENDING')) return KIMI_PROCESS_STATUS.PENDING
  const asNum = Number(status)
  return Number.isFinite(asNum) ? asNum : KIMI_PROCESS_STATUS.UNSPECIFIED
}

export type KimiUploadContext = {
  apiBase: string
  accessToken: string
  headers: Record<string, string>
  timeoutMs?: number
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

/**
 * Upload one file via Kimi web multipart endpoint and return the file id.
 */
export async function uploadKimiFile(
  media: ResolvedMediaBytes,
  ctx: KimiUploadContext,
): Promise<string> {
  const form = new FormData()
  form.append('file', media.buffer, {
    filename: media.filename,
    contentType: media.mimeType,
  })

  const res = await axios.post(`${ctx.apiBase}/apiv2-files/file/upload`, form, {
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'x-msh-platform': 'web',
      ...ctx.headers,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: ctx.timeoutMs ?? 120_000,
    validateStatus: () => true,
    responseType: 'arraybuffer',
    decompress: true,
  })

  const raw = Buffer.from(res.data || [])
  if (res.status < 200 || res.status >= 300) {
    const preview = raw.toString('utf8').slice(0, 240)
    throw new Error(`上传失败: HTTP ${res.status} ${preview}`)
  }

  return extractKimiUploadFileId(raw)
}

/**
 * POST GetFileParseProgress once with a given Content-Type / body encoding.
 */
async function postKimiParseProgress(
  url: string,
  fileId: string,
  ctx: KimiUploadContext,
  mode: 'connect-json' | 'json',
): Promise<{ statusCode: number; raw: Buffer }> {
  const payload = { fileIds: [fileId] }
  const body = mode === 'connect-json' ? encodeConnectJsonFrame(payload) : JSON.stringify(payload)
  const headers: Record<string, string> = {
    ...ctx.headers,
    Authorization: `Bearer ${ctx.accessToken}`,
    'x-msh-platform': 'web',
    'Connect-Protocol-Version': '1',
    Accept: 'application/json',
  }
  if (mode === 'connect-json') {
    headers['Content-Type'] = 'application/connect+json; charset=utf-8'
  } else {
    headers['Content-Type'] = 'application/json'
  }

  const res = await axios.post(url, body, {
    headers,
    timeout: 30_000,
    validateStatus: () => true,
    responseType: 'arraybuffer',
    // Avoid axios rewriting Buffer Content-Type
    transformRequest: [(data) => data],
  })
  return { statusCode: res.status, raw: Buffer.from(res.data || []) }
}

/**
 * Parse progresses[] status from Connect/JSON response body.
 */
function readParseProgressStatus(raw: Buffer, fileId: string): number {
  const body = unwrapConnectBody(raw)
  try {
    const json = JSON.parse(body.toString('utf8'))
    const progress =
      (Array.isArray(json.progresses) && json.progresses.find((p: any) => p.fileId === fileId)) ||
      json.progresses?.[0]
    if (progress) return normalizeKimiProcessStatus(progress.status)
  } catch {
    // keep processing
  }
  return KIMI_PROCESS_STATUS.PROCESSING
}

/**
 * Poll GetFileParseProgress until SUCCESS or FAILED.
 * Retries Content-Type variants when the gateway returns HTTP 415.
 */
export async function waitKimiFileParsed(
  fileId: string,
  ctx: KimiUploadContext,
): Promise<KimiUploadedFile> {
  const pollIntervalMs = ctx.pollIntervalMs ?? 1000
  const pollTimeoutMs = ctx.pollTimeoutMs ?? 90_000
  const deadline = Date.now() + pollTimeoutMs
  const url = `${ctx.apiBase}/apiv2-files/kimi.gateway.file.v1.FileService/GetFileParseProgress`
  // Prefer Connect JSON (same as Chat); fall back to bare JSON if gateway rejects media type.
  let mode: 'connect-json' | 'json' = 'connect-json'
  let sawUnsupportedMedia = false

  while (Date.now() < deadline) {
    let { statusCode, raw } = await postKimiParseProgress(url, fileId, ctx, mode)

    if (statusCode === 415 && mode === 'connect-json') {
      console.warn('[Kimi] 解析进度接口不接受 connect+json，改用 application/json 重试')
      mode = 'json'
      ;({ statusCode, raw } = await postKimiParseProgress(url, fileId, ctx, mode))
    }

    if (statusCode === 415) {
      // 上传已拿到文件标识；部分网关拒绝解析进度的内容类型时，直接带标识进对话
      sawUnsupportedMedia = true
      console.warn('[Kimi] 解析进度仍返回 415，跳过等待，直接使用已上传文件标识:', fileId)
      return { id: fileId, status: KIMI_PROCESS_STATUS.SUCCESS }
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `解析进度失败: HTTP ${statusCode} ${raw.toString('utf8').slice(0, 200)}`,
      )
    }

    const status = readParseProgressStatus(raw, fileId)
    if (status === KIMI_PROCESS_STATUS.SUCCESS) {
      return { id: fileId, status }
    }
    if (status === KIMI_PROCESS_STATUS.FAILED) {
      throw new Error(`文件解析失败: ${fileId}`)
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }

  if (sawUnsupportedMedia) {
    return { id: fileId, status: KIMI_PROCESS_STATUS.SUCCESS }
  }
  throw new Error(`文件解析超时: ${fileId}`)
}

/**
 * Upload media bytes and wait until Kimi finishes parsing.
 */
export async function uploadAndWaitKimiFile(
  media: ResolvedMediaBytes,
  ctx: KimiUploadContext,
): Promise<KimiUploadedFile> {
  const id = await uploadKimiFile(media, ctx)
  return waitKimiFileParsed(id, ctx)
}
