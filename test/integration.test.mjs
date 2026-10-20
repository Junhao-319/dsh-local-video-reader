import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run, locations, readVideo } from '../src/runtime.js'

const python = process.env.VIDEO_READER_TEST_PYTHON
test('video decoding, silent audio, time windows, cache and invalid intervals', { skip: !python }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-video-integration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, '中文 sample.mp4')
  const generate = await run(python, ['-c', 'import imageio_ffmpeg,subprocess,sys;subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),"-y","-loglevel","error","-f","lavfi","-i","testsrc=size=320x180:rate=10:duration=3","-c:v","libx264","-pix_fmt","yuv420p",sys.argv[1]],check=True)', file])
  assert.equal(generate.code, 0, generate.stderr)
  const config = { pythonPath: python, dataDir: path.join(dir, 'state'), allowedRoots: [dir] }
  const result = await readVideo({ path: file, frames: 2, start: 1, end: 2 }, config)
  assert.equal(result.status, 'complete')
  assert.equal(result.asr_status, 'no_audio_stream')
  assert.ok(result.frames.every(frame => frame.seconds >= 1 && frame.seconds <= 2))
  assert.equal(result.frames.length, 2)
  const jpeg = await readFile(result.contact_sheets[0])
  assert.equal(jpeg.readUInt16BE(0), 0xffd8)
  assert.equal((await readVideo({ path: file, frames: 2, start: 1, end: 2 }, config)).cache_hit, true)
  await assert.rejects(readVideo({ path: file, start: 5, end: 6 }, config), /non-empty interval/)
})

test('prepared speech model loads without network access', { skip: !python || !process.env.VIDEO_READER_TEST_MODELS }, async () => {
  const model = path.join(process.env.VIDEO_READER_TEST_MODELS, 'base')
  const r = await run(python, ['-c', 'import sys;from faster_whisper import WhisperModel;WhisperModel(sys.argv[1],device="cpu",compute_type="int8",local_files_only=True);print("offline model loaded")', model], { env: { HF_HUB_OFFLINE: '1', HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' } })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /offline model loaded/)
})

test('speech is transcribed locally from a supplied synthetic video fixture', { skip: !python || !process.env.VIDEO_READER_TEST_MODELS || !process.env.VIDEO_READER_TEST_MEDIA }, async (t) => {
  const out = await mkdtemp(path.join(tmpdir(), 'dsh-video-speech-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const r = await run(python, [locations().script, process.env.VIDEO_READER_TEST_MEDIA, '--frames', '2', '--language', 'zh', '--out', out], {
    env: { DSH_VIDEO_MODELS_DIR: process.env.VIDEO_READER_TEST_MODELS, HF_HUB_OFFLINE: '1', HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' },
  })
  assert.equal(r.code, 0, r.stderr)
  const result = JSON.parse(r.stdout)
  assert.equal(result.asr_status, 'complete')
  assert.ok(result.asr_segments > 0)
  const text = await readFile(result.transcript_path, 'utf8')
  assert.match(text, /红色/)
  assert.match(text, /蓝色/)
})
