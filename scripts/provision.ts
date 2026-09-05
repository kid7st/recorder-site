#!/usr/bin/env bun
/**
 * Create the COS bucket a customer's site lives in, plus a sub-account key
 * scoped to just that bucket.
 *
 *   bun scripts/provision.ts <name> [region]
 *
 * Credentials come from SecretKey.csv (root account) or COS_SECRET_ID/KEY.
 * Idempotent: re-running reports what already exists instead of failing.
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import COS from 'cos-nodejs-sdk-v5'

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest()

/** TC3-HMAC-SHA256, the signature every Tencent Cloud API except COS requires. */
export async function tcApi(service: string, action: string, version: string, payload: object, cred: Cred, region = ''): Promise<any> {
  const host = `${service}.tencentcloudapi.com`
  const body = JSON.stringify(payload)
  const ts = Math.floor(Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const scope = `${date}/${service}/tc3_request`

  const canonical = ['POST', '/', '', `content-type:application/json\nhost:${host}\n`, 'content-type;host', sha256hex(body)].join('\n')
  const toSign = ['TC3-HMAC-SHA256', ts, scope, sha256hex(canonical)].join('\n')
  const signature = hmac(hmac(hmac(hmac(`TC3${cred.secretKey}`, date), service), 'tc3_request'), toSign).toString('hex')
  const auth = `TC3-HMAC-SHA256 Credential=${cred.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`

  const res = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: host,
      Authorization: auth,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(ts),
      ...(region ? { 'X-TC-Region': region } : {}),
    },
    body,
  })
  const json: any = await res.json()
  if (json.Response?.Error) throw new Error(`${action}: ${json.Response.Error.Code} ${json.Response.Error.Message}`)
  return json.Response
}

type Cred = { secretId: string; secretKey: string }

export async function loadCred(): Promise<Cred> {
  if (process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY) {
    return { secretId: process.env.COS_SECRET_ID, secretKey: process.env.COS_SECRET_KEY }
  }
  const csv = 'SecretKey.csv'
  if (!existsSync(csv)) throw new Error('未找到凭证：设置 COS_SECRET_ID/COS_SECRET_KEY 或提供 SecretKey.csv')
  const line = (await Bun.file(csv).text()).trim().split('\n')[1]
  const [secretId, secretKey] = line!.split(',').map(s => s.trim())
  return { secretId: secretId!, secretKey: secretKey! }
}

// COS rejects the request rather than reporting "already exists" as success, so
// re-running has to treat the conflict codes as the desired state.
const EXISTS = new Set(['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'])

// Bun resolves proxy settings once at startup, so deleting the vars at runtime
// does not help and neither does the SDK's Proxy:'' option (it is honoured on
// some request paths and not others). A machine with a VPN proxy has to clear
// them before the process starts. The schedulers are unaffected: launchd and
// Task Scheduler never inherit a shell's proxy vars.
const PROXY_VARS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']
function warnIfProxied(): void {
  const set = PROXY_VARS.filter(k => process.env[k])
  if (set.length) console.warn(`警告：检测到代理 ${process.env[set[0]!]}，腾讯云请求可能被重置。
  请改用：env ${PROXY_VARS.map(k => `-u ${k}`).join(' ')} bun ${process.argv[1]?.split('/').pop()} ...\n`)
}

async function main() {
  const [name, region = 'ap-hongkong'] = process.argv.slice(2)
  warnIfProxied()
  if (!name) throw new Error('用法: bun scripts/provision.ts <name> [region]   例: bun scripts/provision.ts acme ap-hongkong')

  const cred = await loadCred()
  const { AppId, Uin } = await tcApi('cam', 'GetUserAppId', '2019-01-16', {}, cred)
  const bucket = `${name}-${AppId}`
  console.log(`账号 ${Uin} / AppId ${AppId}`)
  console.log(`存储桶 ${bucket} @ ${region}`)

  const cos = new COS({ SecretId: cred.secretId, SecretKey: cred.secretKey })
  const base = { Bucket: bucket, Region: region }

  try {
    // Static website hosting serves anonymous readers: a private bucket 403s
    // every visitor. Safe here only because every page is encrypted before
    // upload — the bucket holds ciphertext, not notes.
    await cos.putBucket({ ...base, ACL: 'public-read' })
    console.log('  ✓ 已创建存储桶（公有读私有写，内容均为密文）')
  } catch (e: any) {
    if (!EXISTS.has(e.code)) throw e
    await cos.putBucketAcl({ ...base, ACL: 'public-read' })
    console.log('  · 存储桶已存在，已确认公有读')
  }

  await cos.putBucketWebsite({
    ...base,
    WebsiteConfiguration: {
      IndexDocument: { Suffix: 'index.html' },
      // Not index.html: when both are missing COS nests one NoSuchKey inside
      // another and shows the visitor a stack of raw XML errors.
      ErrorDocument: { Key: 'error.html' },
    },
  })
  console.log('  ✓ 已开启静态网站托管（索引与错误页均为 index.html）')

  const resource = `qcs::cos:${region}:uid/${AppId}:${bucket}/*`
  const policy = {
    version: '2.0',
    statement: [
      {
        effect: 'allow',
        // Write and delete only: the customer machine holds this key in a
        // readable file, so it must not be able to read or list anything.
        // The multipart actions are required — audio files exceed 5MB.
        action: [
          'name/cos:PutObject',
          'name/cos:DeleteObject',
          'name/cos:InitiateMultipartUpload',
          'name/cos:ListMultipartUploads',
          'name/cos:ListParts',
          'name/cos:UploadPart',
          'name/cos:CompleteMultipartUpload',
          'name/cos:AbortMultipartUpload',
        ],
        resource: [resource],
      },
    ],
  }

  const userName = `recorder-${name}`
  let uin: number
  try {
    const r = await tcApi('cam', 'AddUser', '2019-01-16', { Name: userName, Remark: `recorder-site publisher for ${name}`, ConsoleLogin: 0, UseApi: 1 }, cred)
    uin = r.Uin
    console.log(`  ✓ 已创建子账号 ${userName}`)
    console.log(`      SecretId  ${r.SecretId}`)
    console.log(`      SecretKey ${r.SecretKey}`)
  } catch (e: any) {
    if (!/already exist/i.test(e.message)) throw e
    const r = await tcApi('cam', 'GetUser', '2019-01-16', { Name: userName }, cred)
    uin = r.Uin
    console.log(`  · 子账号 ${userName} 已存在（密钥只在创建时可见，需要新密钥请到控制台生成）`)
  }

  const policyName = `recorder-site-${name}`
  let policyId: number
  try {
    const r = await tcApi('cam', 'CreatePolicy', '2019-01-16', { PolicyName: policyName, PolicyDocument: JSON.stringify(policy), Description: `write-only access to ${bucket}` }, cred)
    policyId = r.PolicyId
    console.log(`  ✓ 已创建策略 ${policyName}`)
  } catch (e: any) {
    if (!/exist/i.test(e.message)) throw e
    const r = await tcApi('cam', 'ListPolicies', '2019-01-16', { Rp: 200, Page: 1, Scope: 'Local', Keyword: policyName }, cred)
    policyId = r.List.find((p: any) => p.PolicyName === policyName)?.PolicyId
    console.log(`  · 策略 ${policyName} 已存在`)
  }

  await tcApi('cam', 'AttachUserPolicy', '2019-01-16', { PolicyId: policyId!, AttachUin: uin! }, cred)
  console.log('  ✓ 已将策略绑定到子账号')

  console.log(`\n下一步：`)
  console.log(`  1. COS 控制台绑定自定义域名（源站类型选「静态网站」），桶 ${bucket}`)
  console.log(`  2. 打包：COS_SECRET_ID=<上面的> COS_SECRET_KEY=<上面的> SITE_PASSWORD=<口令> \\`)
  console.log(`       ./scripts/pack.sh ${name} ${bucket} ${region} https://<客户域名>`)
}

if (import.meta.main) {
  main().catch(e => {
    console.error(`失败: ${e.message}`)
    process.exit(1)
  })
}
