import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('declares a readable DSH profile bundle and an exported plugin entry', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const patch = await readFile(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url), 'utf8')
  assert.match(patch, /name: dsh-local-video-reader/)
  assert.equal(manifest.exports['.'], './src/index.js')
})

let host
try { host = await import('../src/index.js') } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}
test('registers tools with the actual DSH defineTool API and validates settings', { skip: !host }, async () => {
  const definitions = []
  const config = host.Config({})
  assert.deepEqual(config.allowedRoots, [])
  host.apply({ tools: { register: (tool) => definitions.push(tool) } }, config)
  assert.deepEqual(definitions.map(tool => tool.name), ['local_video_doctor', 'local_video_read'])
  const result = JSON.parse(await definitions[1].execute({ path: process.platform === 'win32' ? 'C:/nonexistent.mp4' : '/nonexistent.mp4' }))
  assert.equal(result.status, 'failed')
  assert.match(result.error, /allowedRoots/)
  assert.equal(definitions[1].output.render({}, 'result')[0].text, 'result')
})
