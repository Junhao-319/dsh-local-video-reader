import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { authorizedVideo, locations, run } from '../src/runtime.js'

test('video access requires a configured root and resolves links before checking', async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'dsh-video-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const allowed = path.join(temp, 'allowed')
  const outside = path.join(temp, 'outside')
  await mkdir(allowed); await mkdir(outside)
  const inside = path.join(allowed, '中文 video.mp4'), other = path.join(outside, 'private.mp4')
  await writeFile(inside, 'video'); await writeFile(other, 'video')
  await assert.rejects(authorizedVideo(inside, []), /allowedRoots/)
  assert.equal(await authorizedVideo(inside, [allowed]), inside)
  await assert.rejects(authorizedVideo(other, [allowed]), /outside/)
  await symlink(outside, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(authorizedVideo(path.join(allowed, 'escape/private.mp4'), [allowed]), /outside/)
})

test('subprocess arguments are not interpreted as shell commands', async () => {
  const payload = 'a & echo bad; $(whoami) `whoami` 中文'
  const r = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload])
  assert.equal(r.code, 0); assert.equal(r.stdout, payload)
})

test('timeout and pre-cancelled work do not hang', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /exceeded/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }), /cancelled/)
})

test('running work cancels and excessive process output is bounded', async () => {
  const controller = new AbortController()
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000))'], { maxBytes: 100 }), /output limit/)
})

test('runtime state is outside the npm package and explicit dataDir wins', () => {
  const loc = locations({ dataDir: path.join(tmpdir(), 'video-data') })
  assert.equal(loc.models, path.join(tmpdir(), 'video-data/models'))
  assert.ok(loc.python.includes('venv'))
})
