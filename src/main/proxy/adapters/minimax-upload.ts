/**
 * MiniMax Agent web upload: prepare OSS policy → POST form → object_key for send_msg.
 * Mirrors agent.minimaxi.com `/minimax-cloud/api/v1/uploads/prepare` (purpose MessageAttachment).
 */

import axios from 'axios'
import FormData from 'form-data'
import type { ResolvedMediaBytes } from '../utils/mediaParts'

/** Upload purpose enum from web client */
export const MINIMAX_UPLOAD_PURPOSE = {
  MessageAttachment: 1,
  BotAttachment: 2,
  ContentSafety: 3,
  SkillPackage: 4,
  AgentAvatar: 5,
  FeedbackAttachment: 6,
  InvoiceAttachment: 7,
  RemoteControlAttachment: 8,
} as const

export type MiniMaxAttachment = {
  attachment_type: 1 | 2
  file: {
    object_key: string
    file_name: string
    file_url?: string
  }
}

export type MiniMaxUploadAuth = {
  baseUrl: string
  token: string
  headers: Record<string, string>
  /** Query string already used by matrix requests (device/user fields) */
  buildUrl: (path: string) => string
  signHeaders: (body: unknown) => Record<string, string>
}

/**
 * Upload one media blob and return a send_msg attachment object.
 */
export async function uploadMiniMaxAttachment(
  media: ResolvedMediaBytes,
  auth: MiniMaxUploadAuth,
): Promise<MiniMaxAttachment> {
  const mimeType = (media.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase()
  const prepareBody = {
    purpose: MINIMAX_UPLOAD_PURPOSE.MessageAttachment,
    file_name: media.filename || 'upload.bin',
    mime_type: mimeType,
    size_bytes: media.size,
  }

  const prepareUrl = auth.buildUrl('/minimax-cloud/api/v1/uploads/prepare')
  const prepareRes = await axios.post(prepareUrl, prepareBody, {
    headers: {
      ...auth.headers,
      ...auth.signHeaders(prepareBody),
      token: auth.token,
      'Content-Type': 'application/json',
      Referer: `${auth.baseUrl}/`,
    },
    timeout: 60000,
    validateStatus: () => true,
  })

  const raw = prepareRes.data
  const payload = raw?.object_key ? raw : raw?.data ?? raw
  const statusCode = payload?.base_resp?.status_code ?? (prepareRes.status === 200 ? 0 : prepareRes.status)
  if (statusCode !== 0) {
    throw new Error(
      `MiniMax upload prepare failed: ${payload?.base_resp?.status_msg || JSON.stringify(raw)?.slice(0, 200)}`,
    )
  }

  const objectKey = String(payload.object_key || '').trim()
  const instruction = payload.upload_instruction || payload.uploadInstruction
  const uploadUrl = String(instruction?.url || '').trim()
  const formFields = instruction?.form_fields || instruction?.formFields
  if (!objectKey || !uploadUrl || !formFields || typeof formFields !== 'object') {
    throw new Error('MiniMax upload prepare returned invalid instruction')
  }

  const form = new FormData()
  for (const [key, value] of Object.entries(formFields as Record<string, string>)) {
    form.append(key, String(value))
  }
  form.append('file', media.buffer, {
    filename: media.filename || 'upload.bin',
    contentType: mimeType,
  })

  const putRes = await axios.post(uploadUrl, form, {
    headers: {
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 600_000,
    validateStatus: () => true,
    maxRedirects: 0,
  })

  // Web client expects HTTP 204 from OSS policy success_action_status
  if (putRes.status !== 204 && (putRes.status < 200 || putRes.status >= 300)) {
    throw new Error(`MiniMax OSS upload failed: HTTP ${putRes.status}`)
  }

  return {
    attachment_type: media.kind === 'image' ? 1 : 2,
    file: {
      object_key: objectKey,
      file_name: media.filename,
    },
  }
}
