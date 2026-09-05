#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import os from 'node:os'
import COS from 'cos-nodejs-sdk-v5'
import { indexPlaintext, notePlaintext, sealPage, type Note } from './site'

/**
 * Mirrors voicenote's own appConfigDir/appStateDir rule. It has to match
 * exactly, not merely be reasonable: getting it wrong on Windows means we look
 * for voicenote's config in a directory it never writes, and the workspace
 * silently fails to resolve.
 */
export function appDir(
  kind: 'config' | 'state',
  app: string,
  plat: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const p = plat === 'win32' ? pathWin32 : pathPosix
  if (plat === 'win32') {
    const fallback = kind === 'config' ? ['AppData', 'Roaming'] : ['AppData', 'Local']
    const base = (kind === 'config' ? env.APPDATA : env.LOCALAPPDATA) || p.join(home, ...fallback)
    return p.join(base, app)
  }
  return kind === 'config' ? p.join(home, '.config', app) : p.join(home, '.local', 'state', app)
}

const CONFIG_PATH = join(appDir('config', 'recorder-site'), 'config.json')
const MANIFEST_PATH = join(appDir('state', 'recorder-site'), 'manifest.json')
const VOICENOTE_CONFIG = join(appDir('config', 'voicenote'), 'config.json')

type Config = {
  workspace: string
  password: string
  cos: { secretId: string; secretKey: string; bucket: string; region: string }
  uploadAudio: boolean
  siteUrl: string
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const shortHash = (s: string) => sha(s).slice(0, 16)

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function loadConfig(localOnly: boolean): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) throw new Error(`缺少配置文件 ${CONFIG_PATH}，参考 config.example.json`)
  const raw = await readJson<any>(CONFIG_PATH, {})
  const workspace = raw.workspace || (await readJson<any>(VOICENOTE_CONFIG, {})).VOICENOTE_WORKSPACE
  if (!workspace) throw new Error('未找到 workspace：在配置里设置 workspace，或先配置 voicenote')
  if (!existsSync(workspace)) throw new Error(`workspace 不存在: ${workspace}`)
  // Notes carry client names and pricing. Publishing them unencrypted to a
  // public bucket is not a default anyone should get by forgetting a field.
  if (!raw.password) throw new Error('必须设置 password：站点内容会用它加密，没有口令不允许发布')
  for (const k of localOnly ? [] : ['secretId', 'secretKey', 'bucket', 'region']) {
    if (!raw.cos?.[k]) throw new Error(`缺少 cos.${k}`)
  }
  return {
    workspace,
    password: raw.password,
    cos: raw.cos,
    uploadAudio: raw.uploadAudio !== false,
    // No default from the bucket name: COS forces Content-Disposition:attachment
    // on its own domains for buckets created after 2024-01-01, so the generated
    // URL would download files instead of opening the site. A bound custom
    // domain is the only address that works.
    siteUrl: raw.siteUrl || '(未配置 siteUrl：需绑定自定义域名，COS 默认域名会强制下载)',
  }
}

// ── scan ────────────────────────────────────────────────────────────────────
// voicenote's metadata records absolute paths from whenever they were written,
// so a moved workspace makes final_paths stale. Only the basenames survive a
// move; rejoin them onto the metadata file's own directory.

function sibling(workspace: string, month: string, sub: string, recorded: string | undefined): string | null {
  if (!recorded) return null
  const p = join(workspace, sub, month, basename(recorded))
  return existsSync(p) ? p : null
}

export async function scanNotes(workspace: string): Promise<Note[]> {
  const glob = new Bun.Glob('_metadata/**/*-metadata.json')
  const notes: Note[] = []
  for (const rel of glob.scanSync(workspace)) {
    const path = join(workspace, rel)
    let meta: any
    try {
      meta = JSON.parse(await readFile(path, 'utf8'))
    } catch (e) {
      console.warn(`跳过无法解析的元数据 ${rel}: ${e}`)
      continue
    }
    // A stub without markdown means the summary stage failed; there is nothing
    // to publish yet and voicenote will retry it.
    if (typeof meta.markdown !== 'string' || !meta.markdown.trim()) continue

    const id = basename(path).replace(/-metadata\.json$/, '')
    const month = basename(dirname(path))
    const hash = shortHash(id)
    const audioPath = sibling(workspace, month, '_audio', meta.final_paths?.audio || meta.local_paths?.audio)
    const transcriptPath = sibling(workspace, month, '_transcripts', meta.final_paths?.transcript || meta.local_paths?.transcript)
    notes.push({
      id,
      hash,
      title: meta.title || id,
      date: meta.date || id.slice(0, 10),
      startTime: meta.start_time || '',
      endTime: meta.end_time || null,
      durationSeconds: Number(meta.duration_seconds) || 0,
      participants: (meta.participants || []).filter((p: any) => typeof p === 'string'),
      organizations: (meta.organizations || []).filter((p: any) => typeof p === 'string'),
      projects: (meta.projects || []).filter((p: any) => typeof p === 'string'),
      markdown: meta.markdown,
      transcript: transcriptPath ? await readFile(transcriptPath, 'utf8') : null,
      audioPath,
      audioKey: audioPath ? `a/${hash}${extname(audioPath) || '.mp3'}` : null,
      actionItems: (meta.action_items || [])
        .map((a: any) => (typeof a === 'string' ? a : a?.task))
        .filter((t: any) => typeof t === 'string' && t.trim()),
    })
  }
  notes.sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
  return notes
}

// ── publish ─────────────────────────────────────────────────────────────────

const CONTENT_TYPE: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
}
const contentType = (key: string) => CONTENT_TYPE[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream'

type Plan = {
  /** Every key the site should contain, with its plaintext fingerprint. */
  wanted: Map<string, string>
  /** Rendered bodies, only for keys whose fingerprint changed. */
  texts: Map<string, string>
  files: Map<string, string>
}

// Encryption costs ~200ms per page (PBKDF2), so seal only what changed. The
// fingerprint is of the plaintext, never the ciphertext: fresh salt/IV per run
// means identical notes encrypt differently every time.
export async function buildPlan(config: Config, notes: Note[], manifest: Record<string, string>): Promise<Plan> {
  const wanted = new Map<string, string>()
  const texts = new Map<string, string>()
  const files = new Map<string, string>()

  const pages: { key: string; plaintext: string }[] = notes.map(n => ({ key: `n/${n.hash}.html`, plaintext: notePlaintext(n) }))
  pages.push({ key: 'index.html', plaintext: indexPlaintext(notes) })

  for (const { key, plaintext } of pages) {
    const fingerprint = sha(plaintext)
    wanted.set(key, fingerprint)
    if (manifest[key] !== fingerprint) texts.set(key, await sealPage(key, plaintext, config.password))
  }
  for (const n of notes) {
    if (!config.uploadAudio || !n.audioPath || !n.audioKey) continue
    const st = statSync(n.audioPath)
    const fingerprint = `${st.size}-${Math.floor(st.mtimeMs)}`
    wanted.set(n.audioKey, fingerprint)
    if (manifest[n.audioKey] !== fingerprint) files.set(n.audioKey, n.audioPath)
  }
  return { wanted, texts, files }
}

async function main() {
  const argv = process.argv.slice(2)
  const args = new Set(argv)
  const dryRun = args.has('--dry-run')
  const force = args.has('--force')
  const outDir = argv[argv.indexOf('--out') + 1] && args.has('--out') ? argv[argv.indexOf('--out') + 1] : null
  const started = Date.now()

  const config = await loadConfig(Boolean(outDir) || dryRun)
  const notes = await scanNotes(config.workspace)
  if (notes.length === 0) {
    console.log('没有可发布的笔记')
    return
  }
  const manifest = force || outDir ? {} : await readJson<Record<string, string>>(MANIFEST_PATH, {})
  const plan = await buildPlan(config, notes, manifest)

  // Local render: check the finished site in a browser before any bucket exists.
  if (outDir) {
    for (const [key, body] of plan.texts) {
      await mkdir(dirname(join(outDir, key)), { recursive: true })
      await writeFile(join(outDir, key), body)
    }
    for (const [key, path] of plan.files) {
      await mkdir(dirname(join(outDir, key)), { recursive: true })
      await copyFile(path, join(outDir, key))
    }
    console.log(`已写入 ${plan.texts.size} 个页面、${plan.files.size} 个音频 → ${join(outDir, 'index.html')}`)
    return
  }

  const changed = [...plan.texts.keys(), ...plan.files.keys()]
  const stale = Object.keys(manifest).filter(k => !plan.wanted.has(k))

  console.log(`笔记 ${notes.length} 条 | 待上传 ${changed.length} | 待删除 ${stale.length} | 未变 ${plan.wanted.size - changed.length}`)
  if (dryRun) {
    for (const k of changed) console.log(`  + ${k}`)
    for (const k of stale) console.log(`  - ${k}`)
    return
  }
  if (changed.length === 0 && stale.length === 0) {
    console.log(`站点已是最新：${config.siteUrl}`)
    return
  }

  const cos = new COS({ SecretId: config.cos.secretId, SecretKey: config.cos.secretKey })
  const base = { Bucket: config.cos.bucket, Region: config.cos.region }
  const next = { ...manifest }

  // The first run ships ~1GB of audio. Losing a dropped connection's progress
  // because the manifest is only written on success would re-upload everything,
  // so record what landed even when the run dies partway.
  try {
    for (const key of changed) {
      const body = plan.texts.get(key)
      if (body !== undefined) {
        await cos.putObject({ ...base, Key: key, Body: Buffer.from(body, 'utf8'), ContentType: contentType(key) })
      } else {
        await cos.uploadFile({ ...base, Key: key, FilePath: plan.files.get(key)!, SliceSize: 5 * 1024 * 1024, ContentType: contentType(key) })
      }
      next[key] = plan.wanted.get(key)!
      console.log(`  ↑ ${key}`)
    }
    for (const key of stale) {
      await cos.deleteObject({ ...base, Key: key })
      delete next[key]
      console.log(`  ✕ ${key}`)
    }
  } finally {
    await mkdir(dirname(MANIFEST_PATH), { recursive: true })
    await writeFile(MANIFEST_PATH, JSON.stringify(next, null, 2))
  }
  console.log(`完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s → ${config.siteUrl}`)
}

if (import.meta.main) {
  main().catch(e => {
    console.error(`发布失败: ${e?.message || e}`)
    process.exit(1)
  })
}
