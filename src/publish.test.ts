import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { win32 } from 'node:path'
import { appDir, buildPlan, scanNotes } from './publish'

function fixture(): string {
  const ws = mkdtempSync(join(os.tmpdir(), 'vnsite-'))
  for (const d of ['_metadata/2026-05', '_audio/2026-05', '_transcripts/2026-05']) mkdirSync(join(ws, d), { recursive: true })
  const base = '2026-05-11-204732-demo'
  writeFileSync(
    join(ws, '_metadata/2026-05', `${base}-metadata.json`),
    JSON.stringify({
      title: '演示会议',
      date: '2026-05-11',
      start_time: '20:47',
      duration_seconds: 500,
      participants: ['石洋'],
      action_items: [{ task: '确认报价' }, { task: '' }],
      markdown: '# 演示会议\n\n正文',
      // Deliberately stale: written before the workspace was moved elsewhere.
      final_paths: {
        audio: `/old/place/_audio/2026-05/${base}-original.mp3`,
        transcript: `/old/place/_transcripts/2026-05/${base}-transcript.md`,
      },
    }),
  )
  writeFileSync(join(ws, '_audio/2026-05', `${base}-original.mp3`), 'FAKEAUDIO')
  writeFileSync(join(ws, '_transcripts/2026-05', `${base}-transcript.md`), 'Speaker A: 你好')
  // A summary that never landed: nothing to publish, must not appear.
  writeFileSync(join(ws, '_metadata/2026-05', '2026-05-12-0900-stub-metadata.json'), JSON.stringify({ date: '2026-05-12' }))
  return ws
}

const config = { password: 'pw', uploadAudio: true } as any

// The Windows branch cannot be run on macOS, so pin it by injection instead of
// leaving it as untested code that only fails on the other machine.
test('config and state land where voicenote puts them, on both platforms', () => {
  const win = { APPDATA: 'C:\\Users\\y\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\y\\AppData\\Local' }
  expect(appDir('config', 'voicenote', 'win32', win, 'C:\\Users\\y')).toBe('C:\\Users\\y\\AppData\\Roaming\\voicenote')
  expect(appDir('state', 'recorder-site', 'win32', win, 'C:\\Users\\y')).toBe('C:\\Users\\y\\AppData\\Local\\recorder-site')
  // Missing env vars must still resolve to the real Windows locations.
  expect(appDir('config', 'voicenote', 'win32', {}, 'C:\\Users\\y')).toBe('C:\\Users\\y\\AppData\\Roaming\\voicenote')
  expect(appDir('state', 'voicenote', 'win32', {}, 'C:\\Users\\y')).toBe('C:\\Users\\y\\AppData\\Local\\voicenote')

  expect(appDir('config', 'voicenote', 'darwin', {}, '/Users/y')).toBe('/Users/y/.config/voicenote')
  expect(appDir('state', 'recorder-site', 'linux', {}, '/home/y')).toBe('/home/y/.local/state/recorder-site')
})

test('the month directory survives whichever separator Bun.Glob returns', () => {
  // scanNotes does join(workspace, rel) then basename(dirname(...)). On Windows
  // those are the win32 versions, which accept both separators.
  for (const rel of ['_metadata/2026-05/x-metadata.json', '_metadata\\2026-05\\x-metadata.json']) {
    const full = win32.join('C:\\ws', rel)
    expect(win32.basename(win32.dirname(full))).toBe('2026-05')
  }
})

test('scan resolves siblings through a moved workspace and skips summary stubs', async () => {
  const notes = await scanNotes(fixture())
  expect(notes).toHaveLength(1)
  expect(notes[0]!.title).toBe('演示会议')
  expect(notes[0]!.transcript).toBe('Speaker A: 你好')
  expect(notes[0]!.audioPath).toContain('-original.mp3')
  expect(notes[0]!.actionItems).toEqual(['确认报价'])
})

test('an unchanged workspace uploads nothing on the next run', async () => {
  const notes = await scanNotes(fixture())
  const first = await buildPlan(config, notes, {})
  expect(first.texts.size).toBe(3) // note + index + error
  expect(first.files.size).toBe(1)

  const manifest = Object.fromEntries(first.wanted)
  const second = await buildPlan(config, notes, manifest)
  expect(second.texts.size).toBe(0)
  expect(second.files.size).toBe(0)
  expect(second.wanted).toEqual(first.wanted)
})

test('a re-summarised note re-uploads its page but not its audio', async () => {
  const ws = fixture()
  const notes = await scanNotes(ws)
  const manifest = Object.fromEntries((await buildPlan(config, notes, {})).wanted)

  notes[0]!.markdown = '# 演示会议\n\n修订后的正文'
  const plan = await buildPlan(config, notes, manifest)
  expect([...plan.texts.keys()]).toEqual([`n/${notes[0]!.hash}.html`])
  expect(plan.files.size).toBe(0)
})

test('a touched audio file re-uploads only the audio', async () => {
  const notes = await scanNotes(fixture())
  const manifest = Object.fromEntries((await buildPlan(config, notes, {})).wanted)

  const future = new Date(Date.now() + 60_000)
  utimesSync(notes[0]!.audioPath!, future, future)
  const plan = await buildPlan(config, notes, manifest)
  expect(plan.texts.size).toBe(0)
  expect([...plan.files.keys()]).toEqual([notes[0]!.audioKey!])
})

test('toggling the password re-uploads every page', async () => {
  const notes = await scanNotes(fixture())
  const encrypted = await buildPlan(config, notes, {})
  const manifest = Object.fromEntries(encrypted.wanted)

  // Same notes, no password: plaintext is identical, so only the mode marker in
  // the fingerprint can catch that the uploaded bytes must change.
  const open = await buildPlan({ ...config, password: '' }, notes, manifest)
  expect(open.texts.size).toBe(2) // error.html is never encrypted, so it is unchanged
  expect(open.files.size).toBe(0)
  expect([...open.texts.values()].every(h => !h.includes('const DATA='))).toBe(true)
})

test('uploadAudio:false publishes pages without the recordings', async () => {
  const notes = await scanNotes(fixture())
  const plan = await buildPlan({ ...config, uploadAudio: false }, notes, {})
  expect(plan.files.size).toBe(0)
  expect(plan.texts.size).toBe(3)
})

test('the error page stays readable even when the site is encrypted', async () => {
  const plan = await buildPlan(config, await scanNotes(fixture()), {})
  const err = plan.texts.get('error.html')!
  expect(err).toContain('页面不存在')
  expect(err).not.toContain('const DATA=')
})

test('a workspace with no notes publishes an index rather than nothing', async () => {
  const empty = mkdtempSync(join(os.tmpdir(), 'vnsite-empty-'))
  mkdirSync(join(empty, '_metadata'), { recursive: true })
  const plan = await buildPlan({ ...config, password: '' }, await scanNotes(empty), {})
  expect([...plan.texts.keys()].sort()).toEqual(['error.html', 'index.html'])
  expect(plan.texts.get('index.html')).toContain('还没有记录')
})
