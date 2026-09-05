import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { buildPlan, scanNotes } from './publish'

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
  expect(first.texts.size).toBe(2) // note + index
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

test('uploadAudio:false publishes pages without the recordings', async () => {
  const notes = await scanNotes(fixture())
  const plan = await buildPlan({ ...config, uploadAudio: false }, notes, {})
  expect(plan.files.size).toBe(0)
  expect(plan.texts.size).toBe(2)
})
