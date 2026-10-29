/**
 * Perplexity web file upload: batch_create_upload_urls → S3 multipart → attachment URL.
 */

import axios from 'axios'
import FormData from 'form-data'
import { randomUUID } from 'crypto'
import type { ResolvedMediaBytes } from '../utils/mediaParts'

const PERPLEXITY_URL = 'https://www.perplexity.ai'

export type PerplexityUploadHeaders = Record<string, string>

/**
 * Upload media and return the S3 object URL for params.attachments[].
 */
export async function uploadPerplexityAttachment(
  media: ResolvedMediaBytes,
  cookieHeader: string,
  headers: PerplexityUploadHeaders,
): Promise<string> {
  const fileUuid = randomUUID()
  const meta = {
    filename: media.filename,
    content_type: media.mimeType || 'application/octet-stream',
    source: 'default',
    file_size: media.size,
    force_image: media.kind === 'image',
    skip_parsing: false,
  }

  const createRes = await axios.post(
    `${PERPLEXITY_URL}/rest/uploads/batch_create_upload_urls?version=2.18&source=default`,
    { files: { [fileUuid]: meta } },
    {
      headers: {
        ...headers,
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
        'X-App-ApiClient': 'default',
        'X-App-ApiVersion': '2.18',
      },
      timeout: 60000,
      validateStatus: () => true,
    },
  )

  if (createRes.status < 200 || createRes.status >= 300) {
    throw new Error(
      `Perplexity batch_create_upload_urls failed: HTTP ${createRes.status} ${JSON.stringify(createRes.data)?.slice(0, 200)}`,
    )
  }

  const uploadInfo = createRes.data?.results?.[fileUuid] || createRes.data?.[fileUuid]
  if (!uploadInfo?.s3_bucket_url || !uploadInfo?.fields) {
    throw new Error('Perplexity upload response missing s3_bucket_url/fields')
  }

  const form = new FormData()
  for (const [key, value] of Object.entries(uploadInfo.fields as Record<string, string>)) {
    form.append(key, String(value))
  }
  form.append('file', media.buffer, {
    filename: media.filename,
    contentType: media.mimeType,
  })

  const s3Res = await axios.post(uploadInfo.s3_bucket_url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
    validateStatus: () => true,
  })
  if (s3Res.status < 200 || s3Res.status >= 300) {
    throw new Error(`Perplexity S3 upload failed: HTTP ${s3Res.status}`)
  }

  // Best-effort notify processing (web client waits ~4s)
  try {
    await axios.post(
      `${PERPLEXITY_URL}/rest/sse/attachment_processing/subscribe`,
      { file_uuids: [fileUuid] },
      {
        headers: {
          ...headers,
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
          'X-Perplexity-Request-Endpoint':
            'https://www.perplexity.ai/rest/sse/attachment_processing/subscribe',
        },
        timeout: 15000,
        validateStatus: () => true,
      },
    )
  } catch {
    // ignore subscribe failures
  }
  await new Promise((r) => setTimeout(r, 1500))

  const s3Url = String(uploadInfo.s3_object_url || uploadInfo.s3ObjectUrl || '').trim()
  if (!s3Url) throw new Error('Perplexity upload missing s3_object_url')
  return s3Url
}
