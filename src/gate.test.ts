/**
 * End-to-end check of what a visitor actually does: load the published page,
 * type the password, see the notes. The gate is 30 lines of DOM glue that no
 * other test touches, and a break here makes the whole site unopenable.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GATE_JS, SEARCH_JS, indexPlaintext, notePlaintext, sealPage, type Note } from './site'

const nodeCrypto = globalThis.crypto
GlobalRegistrator.register()
// happy-dom ships a stub SubtleCrypto; the real one is what the page needs.
Object.defineProperty(globalThis, 'crypto', { value: nodeCrypto, configurable: true })

afterAll(() => GlobalRegistrator.unregister())

const note: Note = {
  id: 'demo',
  hash: 'abc123',
  title: '名创报价口径对齐',
  date: '2026-05-11',
  startTime: '20:47',
  endTime: '20:55',
  durationSeconds: 502,
  participants: ['石洋'],
  organizations: [],
  projects: [],
  markdown: '# 名创报价口径对齐\n\n先不卖完整大脑',
  transcript: 'Speaker A: 你好',
  audioPath: '/tmp/x.mp3',
  audioKey: 'a/abc123.mp3',
  actionItems: [],
}

/**
 * Mount a published page and run its own inline script. happy-dom will not
 * execute inline scripts, so the gate code is evaluated directly — it is still
 * the exact string that ships in the HTML, not a reimplementation.
 */
async function loadPage(html: string, withSearch = false) {
  const body = html.match(/<body>([\s\S]*?)<script>/)![1]!
  const data = JSON.parse(html.match(/const DATA=(\{.*?\});/s)![1]!)
  document.body.innerHTML = body
  new Function('DATA', `${withSearch ? SEARCH_JS : ''}${GATE_JS}`)(data)
  await settle()
}

const settle = () => new Promise(r => setTimeout(r, 600))

beforeAll(() => sessionStorage.clear())

test('a visitor types the password and gets the note', async () => {
  await loadPage(await sealPage('n/abc123.html', notePlaintext(note), 'hunter2'))

  expect(document.body.textContent).not.toContain('名创')
  const app = document.getElementById('app')!
  expect(app.style.display).toBe('none')

  const pw = document.getElementById('pw') as HTMLInputElement
  pw.value = 'hunter2'
  ;(document.getElementById('go') as HTMLElement).click()
  await settle()

  expect(app.style.display).toBe('block')
  expect(app.textContent).toContain('名创报价口径对齐')
  expect(app.querySelector('audio')?.getAttribute('src')).toBe('../a/abc123.mp3')
  expect(document.getElementById('gate')!.style.display).toBe('none')
  expect(sessionStorage.getItem('k')).toBe('hunter2')
})

test('a wrong password reports the error and unlocks nothing', async () => {
  sessionStorage.clear()
  await loadPage(await sealPage('n/abc123.html', notePlaintext(note), 'hunter2'))

  const pw = document.getElementById('pw') as HTMLInputElement
  pw.value = 'nope'
  ;(document.getElementById('go') as HTMLElement).click()
  await settle()

  expect(document.getElementById('err')!.textContent).toBe('口令错误')
  expect(document.getElementById('app')!.textContent).toBe('')
  expect(sessionStorage.getItem('k')).toBeNull()
})

test('a remembered password opens the page without asking', async () => {
  sessionStorage.setItem('k', 'hunter2')
  await loadPage(await sealPage('n/abc123.html', notePlaintext(note), 'hunter2'))

  expect(document.getElementById('app')!.textContent).toContain('名创报价口径对齐')
})

test('search on the index filters the list', async () => {
  sessionStorage.setItem('k', 'hunter2')
  const other = { ...note, hash: 'def456', title: '五粮液私域增长', date: '2026-06-01' }
  const plaintext = indexPlaintext([note, other])
  await loadPage(await sealPage('index.html', plaintext, 'hunter2'), true)

  const items = [...document.querySelectorAll('.item')] as HTMLElement[]
  expect(items).toHaveLength(2)

  const q = document.getElementById('q') as HTMLInputElement
  q.value = '五粮液'
  q.dispatchEvent(new Event('input'))
  expect(items.map(i => i.style.display)).toEqual(['none', ''])

  q.value = ''
  q.dispatchEvent(new Event('input'))
  expect(items.map(i => i.style.display)).toEqual(['', ''])
})
