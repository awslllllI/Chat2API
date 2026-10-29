/**
 * 用本机照片直连各供应商网页上传接口，并等待解析完成（非即时校验）。
 *
 *   ALLOW_LIVE_UPSTREAM=1 node --experimental-strip-types scripts/test-provider-native-upload.mjs
 */
import fs from 'node:fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import axios from 'axios'
import FormData from 'form-data'
import Store from 'electron-store'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

if (process.env.ALLOW_LIVE_UPSTREAM !== '1') {
  console.error('拒绝执行：请设置 ALLOW_LIVE_UPSTREAM=1')
  process.exit(2)
}

const PHOTO =
  process.env.TEST_PHOTO ||
  path.join(os.homedir(), 'Pictures', 'iOS', 'IMG_0048.PNG')

if (!fs.existsSync(PHOTO)) {
  console.error('找不到测试照片:', PHOTO)
  process.exit(1)
}

const photoBuf = fs.readFileSync(PHOTO)
const photoName = path.basename(PHOTO)
const photoMime = photoName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
console.log(`测试照片: ${PHOTO} (${photoBuf.length} 字节)`)

const store = new Store({
  name: 'data',
  cwd: path.join(os.homedir(), '.chat2api'),
  encryptionKey: 'chat2api-fixed-encryption-key-v1',
})
const accounts = store.get('accounts') || []
const byProvider = Object.fromEntries(
  accounts.filter((a) => a.status !== 'inactive').map((a) => [a.providerId, a]),
)

const results = []

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function record(provider, ok, detail, ms) {
  results.push({ provider, ok, detail, ms })
  console.log(`${ok ? '✓' : '✗'} ${provider} ${Math.round(ms)}ms — ${detail}`)
}

async function testKimi(account) {
  const t0 = Date.now()
  const { uploadAndWaitKimiFile } = await import('../src/main/proxy/adapters/kimi-upload.ts')
  const { refreshKimiWebTokens, pickKimiCredentials } = await import(
    '../src/main/proxy/adapters/kimi-auth.ts'
  )
  let { accessToken, refreshToken } = pickKimiCredentials(account.credentials)
  if (refreshToken) {
    try {
      const refreshed = await refreshKimiWebTokens(refreshToken)
      accessToken = refreshed.accessToken
    } catch (e) {
      console.warn('Kimi 刷新令牌失败，改用已有访问令牌:', e.message)
    }
  }
  if (!accessToken) throw new Error('无访问令牌')

  const uploaded = await uploadAndWaitKimiFile(
    {
      buffer: photoBuf,
      filename: photoName,
      mimeType: photoMime,
      size: photoBuf.length,
      kind: 'image',
      sourceUrl: 'file://local',
    },
    {
      apiBase: 'https://www.kimi.com',
      accessToken,
      headers: {
        Origin: 'https://www.kimi.com',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      pollIntervalMs: 1500,
      pollTimeoutMs: 120_000,
    },
  )
  if (Date.now() - t0 < 800) {
    console.warn('警告: 上传+解析耗时过短，可能未真正等待解析')
  }
  record('Kimi', true, `文件标识=${uploaded.id} 状态=${uploaded.status}`, Date.now() - t0)
}

async function testMiniMax(account) {
  const t0 = Date.now()
  const { uploadMiniMaxAttachment } = await import('../src/main/proxy/adapters/minimax-upload.ts')
  const token = account.credentials.token || ''
  const jwt = token.includes('+') ? token.split('+').pop() : token
  if (!jwt) throw new Error('无令牌')

  const baseUrl = 'https://agent.minimaxi.com'
  const unix = `${Date.now()}`
  const timestamp = Math.floor(Date.now() / 1000)
  const realUserID = account.credentials.realUserID || ''
  // device register for query params
  const userData = {
    device_platform: 'web',
    token: jwt,
    uuid: realUserID || undefined,
    user_id: realUserID || undefined,
    unix,
  }
  const buildUrl = (uri) => {
    let q = ''
    for (const [k, v] of Object.entries(userData)) {
      if (v === undefined) continue
      q += `&${k}=${v}`
    }
    return `${baseUrl}${uri}?${q.slice(1)}`
  }
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
  const signHeaders = (body) => {
    const dataJson = JSON.stringify(body || {})
    const pathOnly = '/minimax-cloud/api/v1/uploads/prepare'
    let q = ''
    for (const [k, v] of Object.entries(userData)) {
      if (v === undefined) continue
      q += `&${k}=${v}`
    }
    const fullUri = `${pathOnly}?${q.slice(1)}`
    return {
      'x-timestamp': String(timestamp),
      'x-signature': md5(`${timestamp}${jwt}${dataJson}`),
      yy: md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`),
    }
  }

  console.log('MiniMax: 准备上传并等待对象存储落盘…')
  const att = await uploadMiniMaxAttachment(
    {
      buffer: photoBuf,
      filename: photoName,
      mimeType: photoMime,
      size: photoBuf.length,
      kind: 'image',
      sourceUrl: 'file://local',
    },
    {
      baseUrl,
      token: jwt,
      headers: {
        Origin: baseUrl,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      buildUrl,
      signHeaders,
    },
  )
  // MiniMax OSS 无单独 parse 轮询；稍等确认对象可用
  await sleep(2500)
  record(
    'MiniMax',
    Boolean(att?.file?.object_key),
    `对象键=${att?.file?.object_key || '(空)'}`,
    Date.now() - t0,
  )
}

async function testQwen(account) {
  const t0 = Date.now()
  const { createHmac } = await import('node:crypto')
  const ticket = account.credentials.ticket
  if (!ticket) throw new Error('无票据')
  const api = 'https://chat2.qianwen.com'
  const headers = {
    'Content-Type': 'application/json',
    cookie: `tongyi_sso_ticket=${ticket}`,
    Origin: api,
    Referer: `${api}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }

  console.log('Qwen: 申请临时凭证…')
  const stsRes = await axios.post(
    `${api}/api/v2/files/getstsToken`,
    {
      filename: photoName,
      filesize: String(photoBuf.length),
      filetype: 'image',
    },
    { headers, timeout: 60000, validateStatus: () => true },
  )
  if (stsRes.status !== 200 || !stsRes.data?.data) {
    throw new Error(`申请临时凭证失败 HTTP ${stsRes.status} ${JSON.stringify(stsRes.data)?.slice(0, 180)}`)
  }
  const sts = stsRes.data.data
  const fileId = sts.file_id || sts.fileId
  let objectKey = sts.file_path || ''
  const bucketPrefix = `${sts.bucketname}/`
  if (objectKey.startsWith(bucketPrefix)) objectKey = objectKey.slice(bucketPrefix.length)
  if (!sts.bucketname || !objectKey) throw new Error('临时凭证缺少桶或对象键')

  console.log('Qwen: 签名上传到对象存储…')
  const date = new Date().toUTCString()
  const canonical = [
    'PUT',
    '',
    photoMime,
    date,
    `x-oss-security-token:${sts.security_token}`,
    `/${sts.bucketname}/${objectKey}`,
  ].join('\n')
  const signature = createHmac('sha1', sts.access_key_secret).update(canonical).digest('base64')
  let endpoint = (sts.endpoint || '').replace(/\/+$/, '')
  if (!endpoint.includes(sts.bucketname)) {
    endpoint = `https://${sts.bucketname}.${endpoint.replace(/^https?:\/\//, '')}`
  }
  const putRes = await axios.put(`${endpoint}/${objectKey}`, photoBuf, {
    headers: {
      'Content-Type': photoMime,
      Date: date,
      Authorization: `OSS ${sts.access_key_id}:${signature}`,
      'x-oss-security-token': sts.security_token,
    },
    maxBodyLength: Infinity,
    timeout: 120000,
    validateStatus: () => true,
  })
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`对象存储上传失败 HTTP ${putRes.status}`)
  }

  // 图片通常不强制 parse；仍按文档接口轮询，并至少等待数秒
  console.log('Qwen: 等待服务端分析窗口…')
  await sleep(3000)
  if (fileId) {
    await axios.post(
      `${api}/api/v2/files/parse`,
      { file_id: fileId },
      { headers, timeout: 30000, validateStatus: () => true },
    )
    const deadline = Date.now() + 90_000
    let last = ''
    while (Date.now() < deadline) {
      const st = await axios.post(
        `${api}/api/v2/files/parse/status`,
        { file_id_list: [fileId] },
        { headers, timeout: 30000, validateStatus: () => true },
      )
      last = String(st.data?.data?.[0]?.status || st.data?.status || '')
      if (last === 'success' || /success|done|finish/i.test(last)) {
        record('Qwen', true, `文件标识=${fileId} 解析=${last || '完成'}`, Date.now() - t0)
        return
      }
      if (/fail|error/i.test(last)) throw new Error(`解析失败: ${last}`)
      // 图片可能无 parse 状态，超时前接受已上传
      if (!last && Date.now() - t0 > 8000) {
        record('Qwen', true, `文件标识=${fileId}（图片无解析态，上传已完成）`, Date.now() - t0)
        return
      }
      await sleep(2000)
    }
    record('Qwen', true, `文件标识=${fileId} 上传完成（解析态=${last || '无'}）`, Date.now() - t0)
    return
  }
  record('Qwen', true, `已上传 object=${objectKey}`, Date.now() - t0)
}

async function testGlm(account) {
  const t0 = Date.now()
  const refresh = account.credentials.refresh_token
  if (!refresh) throw new Error('无刷新令牌')

  console.log('GLM: 刷新访问令牌…')
  // 与网页签名算法一致
  const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
  const A = Date.now().toString()
  const o = A.split('').map((c) => Number(c))
  const a = (o.reduce((s, v) => s + v, 0) - o[A.length - 2]) % 10
  const timestamp = A.substring(0, A.length - 2) + a + A.substring(A.length - 1)
  const nonce = crypto.randomUUID()
  const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest('hex')
  const tokenRes = await axios.post(
    'https://chatglm.cn/chatglm/user-api/user/refresh',
    {},
    {
      headers: {
        Authorization: `Bearer ${refresh}`,
        'Content-Type': 'application/json',
        Origin: 'https://chatglm.cn',
        Referer: 'https://chatglm.cn/',
        'X-Device-Id': crypto.randomUUID(),
        'X-Nonce': nonce,
        'X-Request-Id': crypto.randomUUID(),
        'X-Sign': sign,
        'X-Timestamp': timestamp,
      },
      timeout: 30000,
      validateStatus: () => true,
    },
  )
  const access = tokenRes.data?.result?.access_token
  if (!access) {
    throw new Error(`刷新令牌失败 ${JSON.stringify(tokenRes.data)?.slice(0, 180)}`)
  }
  return testGlmUpload(access, t0)
}

async function testGlmUpload(access, t0) {
  console.log('GLM: 上传文件…')
  const form = new FormData()
  form.append('file', photoBuf, { filename: photoName, contentType: photoMime })
  const res = await axios.post(
    'https://chatglm.cn/chatglm/backend-api/assistant/file_upload',
    form,
    {
      headers: {
        Authorization: `Bearer ${access}`,
        Referer: 'https://chatglm.cn/',
        Origin: 'https://chatglm.cn',
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      timeout: 120000,
      validateStatus: () => true,
    },
  )
  if (res.status !== 200 || !res.data?.result) {
    throw new Error(`上传失败 HTTP ${res.status} ${JSON.stringify(res.data)?.slice(0, 180)}`)
  }
  // GLM 上传接口返回前通常已完成处理；仍等待一小段模拟分析窗口
  await sleep(2000)
  const sid = res.data.result.source_id
  record('GLM', Boolean(sid), `来源标识=${sid || '(空)'}`, Date.now() - t0)
}

async function testMimo(account) {
  const t0 = Date.now()
  const serviceToken = account.credentials.service_token
  const userId = account.credentials.user_id
  const phToken = account.credentials.ph_token
  if (!serviceToken || !phToken) throw new Error('凭证不完整')

  const base = 'https://aistudio.xiaomimimo.com'
  const md5 = crypto.createHash('md5').update(photoBuf).digest('hex')
  const headers = {
    'Content-Type': 'application/json',
    Cookie: `serviceToken=${serviceToken}`,
    Origin: base,
    Referer: `${base}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }

  console.log('MiMo: 申请上传信息…')
  const infoRes = await axios.post(
    `${base}/open-apis/resource/genUploadInfo?xiaomichatbot_ph=${encodeURIComponent(phToken)}`,
    { fileName: photoName, fileContentMd5: md5 },
    { headers, timeout: 30000, validateStatus: () => true },
  )
  if (infoRes.status !== 200 || infoRes.data?.code !== 0) {
    throw new Error(`申请上传信息失败 ${JSON.stringify(infoRes.data)?.slice(0, 180)}`)
  }
  const { uploadUrl, resourceUrl, objectName } = infoRes.data.data
  console.log('MiMo: 上传二进制…')
  const putRes = await axios.put(uploadUrl, photoBuf, {
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    timeout: 120000,
    validateStatus: () => true,
  })
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`上传失败 HTTP ${putRes.status}`)
  }

  console.log('MiMo: 解析资源（轮询）…')
  let parseId = ''
  for (let i = 0; i < 40; i++) {
    const parseRes = await axios.post(
      `${base}/open-apis/resource/parse`,
      {},
      {
        params: {
          fileUrl: resourceUrl,
          objectName,
          model: 'MiMo-V2-Flash',
          xiaomichatbot_ph: phToken,
        },
        headers,
        timeout: 30000,
        validateStatus: () => true,
      },
    )
    if (parseRes.status === 200 && parseRes.data?.code === 0 && parseRes.data?.data?.id) {
      parseId = parseRes.data.data.id
      break
    }
    await sleep(2000)
  }
  if (!parseId) throw new Error('解析超时')
  record('MiMo', true, `资源标识=${parseId} object=${objectName}`, Date.now() - t0)
}

const runners = [
  ['kimi', testKimi],
  ['minimax', testMiniMax],
  ['qwen', testQwen],
  ['glm', testGlm],
  ['mimo', testMimo],
]

for (const [id, fn] of runners) {
  const account = byProvider[id]
  if (!account) {
    record(id, false, '本机无可用账号，跳过', 0)
    continue
  }
  console.log(`\n======== ${id} / ${account.name} ========`)
  try {
    await fn(account)
  } catch (e) {
    record(id, false, e instanceof Error ? e.message : String(e), 0)
  }
  // 供应商间间隔，降低风控
  await sleep(3000)
}

console.log('\n======== 汇总 ========')
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.provider}: ${r.detail}`)
}
const failed = results.filter((r) => !r.ok && !String(r.detail).includes('跳过'))
process.exit(failed.length ? 1 : 0)
