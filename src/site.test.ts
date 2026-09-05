import { expect, test } from 'bun:test'
import { DECRYPT_JS, indexPlaintext, notePlaintext, seal, sealPage, unseal, fmtDuration, type Note } from './site'

const note = (over: Partial<Note> = {}): Note => ({
  id: '2026-05-11-204732-demo',
  hash: 'abc123',
  title: '名创报价口径对齐',
  date: '2026-05-11',
  startTime: '20:47',
  endTime: '20:55',
  durationSeconds: 502,
  participants: ['石洋'],
  organizations: ['名创'],
  projects: ['DT 大脑'],
  markdown: '# 标题\n\n正文 **粗体**',
  transcript: 'Speaker A: 你好',
  audioPath: '/tmp/x.mp3',
  audioKey: 'a/abc123.mp3',
  actionItems: ['确认报价口径'],
  ...over,
})

test('seal/unseal round-trips and rejects a wrong password', async () => {
  const sealed = await seal('客户报价 300 万', 'hunter2')
  expect(await unseal(sealed, 'hunter2')).toBe('客户报价 300 万')
  expect(unseal(sealed, 'wrong')).rejects.toThrow()
})

test('the browser-side decrypt code opens what seal() produced', async () => {
  const browserUnseal = new Function(`${DECRYPT_JS}; return unseal`)() as (d: unknown, pw: string) => Promise<string>
  expect(await browserUnseal(await seal('客户报价 300 万', 'hunter2'), 'hunter2')).toBe('客户报价 300 万')
})

test('each seal uses a fresh salt and IV', async () => {
  const a = await seal('same', 'pw')
  const b = await seal('same', 'pw')
  expect(a.c).not.toBe(b.c)
  expect(a.i).not.toBe(b.i)
})

test('sealed page ships no plaintext', async () => {
  const plaintext = notePlaintext(note())
  const html = await sealPage('n/abc123.html', plaintext, 'pw')
  expect(html).not.toContain('名创')
  expect(html).not.toContain('Speaker A')
  expect(html).not.toContain('报价')
  expect(await unseal(JSON.parse(html.match(/const DATA=(\{.*?\});/s)![1]), 'pw')).toBe(plaintext)
})

test('only the index page carries the search script', async () => {
  expect(await sealPage('index.html', 'x', 'pw')).toContain('window.onReady=')
  expect(await sealPage('n/a.html', 'x', 'pw')).not.toContain('window.onReady=')
})

test('note page renders audio, markdown and transcript', () => {
  const html = notePlaintext(note())
  expect(html).toContain('src="../a/abc123.mp3"')
  expect(html).toContain('<strong>粗体</strong>')
  expect(html).toContain('完整转录')
})

test('note page omits the player when audio is missing', () => {
  expect(notePlaintext(note({ audioKey: null }))).not.toContain('<audio')
})

test('index lists notes, action items and searchable text', () => {
  const html = indexPlaintext([note(), note({ hash: 'def', title: '第二条', actionItems: [] })])
  expect(html).toContain('href="n/abc123.html"')
  expect(html).toContain('待办事项 (1)')
  expect(html).toContain('确认报价')
  expect(html).toContain('data-s="名创报价口径对齐 2026-05-11 石洋 dt 大脑 名创"')
})

test('every action item reaches the page, not just the first screenful', () => {
  const many = Array.from({ length: 60 }, (_, i) => note({ hash: `h${i}`, actionItems: [`任务${i}`] }))
  const html = indexPlaintext(many)
  expect(html).toContain('待办事项 (60)')
  expect(html).toContain('任务59')
})

test('duration formats past an hour', () => {
  expect(fmtDuration(502)).toBe('8 分钟')
  expect(fmtDuration(5000)).toBe('1 小时 23 分')
  expect(fmtDuration(0)).toBe('')
})
