#!/usr/bin/env node
import path from 'node:path'
import { doctor, readVideo, setup } from '../src/runtime.js'

const [command = 'help', ...raw] = process.argv.slice(2)
const config = {}
const options = {}
let video
try {
const valueAfter = (index) => {
  const value = raw[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value after ${raw[index]}`)
  return value
}
for (let i = 0; i < raw.length; i++) {
  const flag = raw[i]
  if (flag === '--data-dir') { config.dataDir = valueAfter(i); i++ }
  else if (flag === '--python') { config.pythonPath = valueAfter(i); i++ }
  else if (flag === '--allow-root') { (config.allowedRoots ||= []).push(path.resolve(valueAfter(i))); i++ }
  else if (flag === '--no-asr') options.transcribe = false
  else if (['--start', '--end', '--frames'].includes(flag)) { options[flag.slice(2)] = Number(valueAfter(i)); i++ }
  else if (['--model', '--language'].includes(flag)) { options[flag.slice(2)] = valueAfter(i); i++ }
  else if (!flag.startsWith('-') && !video) video = flag
  else throw new Error(`Unknown argument: ${flag}`)
}
  let result
  if (command === 'setup') result = await setup(config, { ...options, onStderr: (text) => process.stderr.write(text) })
  else if (command === 'doctor') result = await doctor(config)
  else if (command === 'read' && video) result = await readVideo({ ...options, path: path.resolve(video) }, config)
  else if (command === 'help' || command === '--help') {
    console.log('dsh-local-video-reader setup [--model base|small] [--data-dir PATH]\ndsh-local-video-reader doctor [--data-dir PATH]\ndsh-local-video-reader read VIDEO --allow-root FOLDER [--start SECONDS] [--end SECONDS] [--frames 12] [--no-asr]\nRequires Python 3.12–3.14 for setup. Setup downloads dependencies and model weights. Reading then runs locally. See README for DSH installation.')
    process.exit(0)
  } else throw new Error('Use setup, doctor, read VIDEO, or --help')
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'partial' || result.ready === false) process.exitCode = 2
} catch (error) { console.error(error.message); process.exitCode = 1 }
