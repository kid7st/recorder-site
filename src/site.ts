import { marked } from 'marked'
import { randomBytes } from 'node:crypto'

export type Note = {
  id: string
  hash: string
  title: string
  date: string
  startTime: string
  endTime: string | null
  durationSeconds: number
  participants: string[]
  organizations: string[]
  projects: string[]
  markdown: string
  transcript: string | null
  audioPath: string | null
  audioKey: string | null
  actionItems: string[]
}

const PBKDF2_ITERATIONS = 250_000

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function fmtDuration(seconds: number): string {
  if (!seconds || seconds < 0) return ''
  const m = Math.round(seconds / 60)
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

// ── encryption ──────────────────────────────────────────────────────────────
// Notes carry client names and pricing, so the bucket must not serve readable
// content even if its URL leaks. Random salt+IV per call keeps AES-GCM sound;
// the publish manifest hashes plaintext, so re-encrypting the same note still
// produces a no-op upload.

export type Sealed = { s: string; i: string; c: string; n: number }

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  )
}

export async function seal(plaintext: string, password: string): Promise<Sealed> {
  const salt = Uint8Array.from(randomBytes(16))
  const iv = Uint8Array.from(randomBytes(12))
  const key = await deriveKey(password, salt, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as any).toString('base64')
  return { s: b64(salt), i: b64(iv), c: b64(ct), n: PBKDF2_ITERATIONS }
}

export async function unseal(sealed: Sealed, password: string): Promise<string> {
  const b = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'))
  const key = await deriveKey(password, b(sealed.s), ['decrypt'])
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(sealed.i) }, key, b(sealed.c))
  return new TextDecoder().decode(pt)
}

// ── page shell ──────────────────────────────────────────────────────────────

const STYLE = `
:root{--fg:#1f2328;--dim:#5b6572;--line:#e3e8ef;--bg:#fff;--accent:#2f6feb}
@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--dim:#9aa7b4;--line:#2b3138;--bg:#14181d;--accent:#6ea8fe}}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
line-height:1.72;color:var(--fg);background:var(--bg);max-width:860px;margin:0 auto;padding:28px 20px 80px;font-size:16px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:26px;line-height:1.35;margin:.2em 0 .5em}
h2{font-size:20px;margin-top:2em;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:17px;margin-top:1.6em}
p,ul,ol,blockquote,table{margin:.85em 0}
blockquote{border-left:3px solid var(--line);padding-left:14px;color:var(--dim);margin-left:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(127,127,127,.14);padding:.12em .35em;border-radius:4px;font-size:.9em}
pre{background:rgba(127,127,127,.1);padding:12px;border-radius:8px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:.94em}
th,td{border:1px solid var(--line);padding:7px 10px;vertical-align:top;text-align:left}
audio{width:100%;margin:14px 0}
.meta{color:var(--dim);font-size:14px}
.tag{display:inline-block;background:rgba(127,127,127,.14);border-radius:999px;padding:1px 10px;font-size:12px;margin:0 6px 6px 0;color:var(--dim)}
.item{padding:16px 0;border-bottom:1px solid var(--line)}
.item h2{border:0;margin:0 0 4px;font-size:17px;font-weight:600}
.item a{color:var(--fg)}
#q{width:100%;padding:11px 14px;font-size:15px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);margin-bottom:6px}
#gate{max-width:340px;margin:22vh auto;text-align:center}
#gate input{width:100%;padding:11px 14px;font-size:16px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg)}
#gate button{width:100%;margin-top:10px;padding:11px;font-size:15px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
#err{color:#d1242f;font-size:14px;min-height:20px;margin-top:8px}
details{margin-top:1.4em}summary{cursor:pointer;color:var(--dim)}
.back{font-size:14px}
`

/**
 * Shipped to the browser and exercised by site.test.ts against seal() output:
 * if these parameters ever drift from the Node side, the site becomes an
 * undecryptable brick, and nothing else would catch it.
 */
export const DECRYPT_JS = `
const B=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function unseal(d,pw){
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']);
  const k=await crypto.subtle.deriveKey({name:'PBKDF2',salt:B(d.s),iterations:d.n,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:B(d.i)},k,B(d.c)));
}`

// Password lives in sessionStorage: reload inside a tab stays open, closing it
// re-locks. localStorage would leave plaintext creds on a shared machine.
export const GATE_JS = `${DECRYPT_JS}
// crypto.subtle only exists in a secure context. Over plain http the page would
// otherwise accept the password and do nothing at all, which reads as a broken
// site rather than a misconfigured one.
if(location.protocol==='http:'&&!['localhost','127.0.0.1'].includes(location.hostname))location.replace(location.href.replace(/^http:/,'https:'));
if(!crypto.subtle)document.getElementById('err').textContent='需要 HTTPS 才能解密，请用 https:// 打开';
async function open(pw){
  const html=await unseal(DATA,pw);
  sessionStorage.setItem('k',pw);
  document.getElementById('gate').style.display='none';
  const app=document.getElementById('app');
  app.innerHTML=html;app.style.display='block';
  document.title=app.querySelector('h1')?.textContent||document.title;
  if(window.onReady)window.onReady();
}
async function submit(){
  const el=document.getElementById('pw'),err=document.getElementById('err');
  err.textContent='校验中…';
  try{await open(el.value)}catch(e){err.textContent='口令错误';el.select()}
}
document.getElementById('go').onclick=submit;
document.getElementById('pw').onkeydown=e=>{if(e.key==='Enter')submit()};
const saved=sessionStorage.getItem('k');
if(saved){open(saved).catch(()=>{sessionStorage.removeItem('k');document.getElementById('pw').focus()})}
else document.getElementById('pw').focus();
`

export const SEARCH_JS = `
window.onReady=()=>{
  const q=document.getElementById('q');if(!q)return;
  const items=[...document.querySelectorAll('.item')];
  q.oninput=()=>{const v=q.value.trim().toLowerCase();
    for(const it of items)it.style.display=!v||it.dataset.s.includes(v)?'':'none'};
  q.focus();
};`

function shell(title: string, sealed: Sealed, extraJs = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<div id="gate"><input id="pw" type="password" placeholder="访问口令" autocomplete="current-password">
<button id="go">进入</button><div id="err"></div></div>
<div id="app" style="display:none"></div>
<script>const DATA=${JSON.stringify(sealed)};${extraJs}${GATE_JS}
</script>
</body></html>`
}

// ── content ─────────────────────────────────────────────────────────────────

function listSection(title: string, rows: string[]): string {
  return rows.length ? `<details><summary>${title}</summary><ul>${rows.map(r => `<li>${r}</li>`).join('')}</ul></details>` : ''
}

export function notePlaintext(n: Note): string {
  const when = `${n.date} ${n.startTime}${n.endTime ? `–${n.endTime}` : ''}`
  const dur = fmtDuration(n.durationSeconds)
  const tags = [...n.projects, ...n.organizations].map(t => `<span class="tag">${esc(t)}</span>`).join('')
  const audio = n.audioKey ? `<audio controls preload="none" src="../${n.audioKey}"></audio>` : ''
  const transcript = n.transcript
    ? `<details><summary>完整转录</summary>${marked.parse(n.transcript, { async: false })}</details>`
    : ''
  return `<p class="back"><a href="../index.html">← 全部记录</a></p>
<p class="meta">${esc(when)}${dur ? ` · ${dur}` : ''}${n.participants.length ? ` · ${esc(n.participants.join('、'))}` : ''}</p>
${tags ? `<p>${tags}</p>` : ''}
${audio}
${marked.parse(n.markdown, { async: false })}
${transcript}`
}

export function indexPlaintext(notes: Note[]): string {
  const items = notes.map(n => {
    const dur = fmtDuration(n.durationSeconds)
    const sub = [n.date, dur, n.participants.join('、'), n.projects.join(' / ')].filter(Boolean).join(' · ')
    const searchable = esc([n.title, n.date, ...n.participants, ...n.projects, ...n.organizations].join(' ').toLowerCase())
    return `<div class="item" data-s="${searchable}">
<h2><a href="n/${n.hash}.html">${esc(n.title)}</a></h2>
<div class="meta">${esc(sub)}</div></div>`
  })
  // Every item, newest first. Truncating here silently dropped 313 of 353.
  const actions = notes.flatMap(n => n.actionItems.map(task => ({ task, n })))
  const pending = listSection(
    `待办事项 (${actions.length})`,
    actions.map(a => `${esc(a.task)} <a class="meta" href="n/${a.n.hash}.html">${esc(a.n.date)}</a>`),
  )
  // Keyed off the newest note, not the clock: a wall-clock stamp would change
  // the page fingerprint on every run and re-upload a site that never changed.
  const latest = notes[0] ? `最新 ${notes[0].date}` : ''
  return `<h1>录音记录</h1>
<p class="meta">${notes.length} 条 · ${latest}</p>
<input id="q" type="search" placeholder="搜索标题、日期、参与者、项目" autocomplete="off">
${items.join('')}
${pending}`
}

/**
 * Wrap page content for upload. With a password the body is encrypted behind the
 * gate; without one it ships readable to anyone who loads the URL.
 *
 * The browser title stays generic either way — in the encrypted mode a real
 * title in the tab or in history would leak the client names the body protects.
 */
export async function sealPage(key: string, plaintext: string, password: string): Promise<string> {
  const search = key === 'index.html' ? SEARCH_JS : ''
  if (!password) return openShell('录音记录', plaintext, search)
  return shell('录音记录', await seal(plaintext, password), search)
}

function openShell(title: string, body: string, extraJs: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<div id="app">${body}</div>
${extraJs ? `<script>${extraJs}\nwindow.onReady()</script>` : ''}
</body></html>`
}
