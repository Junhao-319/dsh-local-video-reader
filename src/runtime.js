import { spawn } from 'node:child_process'
import { mkdir, realpath, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = fileURLToPath(new URL('../', import.meta.url))
export function locations(config = {}) {
  const root = path.resolve(config.dataDir || process.env.DSH_VIDEO_READER_HOME || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'tools', 'local-video-reader'))
  return {
    root,
    python: config.pythonPath || path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    models: path.join(root, 'models'),
    cache: path.join(root, 'cache'),
    script: path.join(packageRoot, 'python', 'read_video.py'),
  }
}

export function run(command, args, { signal, timeoutMs = 600_000, env = {}, maxBytes = 8_000_000, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return reject(new Error('timeoutMs must be positive and finite'))
    if (signal?.aborted) return reject(new Error('Operation cancelled'))
    const child = spawn(command, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', ...env } })
    let stdout = '', stderr = '', size = 0, failure, finished = false, fallbackTimer
    const stop = (error) => {
      if (failure) return
      failure = error
      if (child.pid && !finished) {
        if (process.platform === 'win32') {
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()).on('exit', (code) => { if (code) child.kill() })
          fallbackTimer = setTimeout(() => child.kill(), 1000)
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }
      }
    }
    const onAbort = () => stop(new Error('Operation cancelled'))
    const timer = setTimeout(() => stop(new Error(`Operation exceeded ${timeoutMs} ms`)), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => { finished = true; clearTimeout(timer); clearTimeout(fallbackTimer); signal?.removeEventListener('abort', onAbort) }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data) => { size += Buffer.byteLength(data); if (size > maxBytes) stop(new Error('Process output limit exceeded')); else stdout += data })
    child.stderr.on('data', (data) => { size += Buffer.byteLength(data); if (size > maxBytes) stop(new Error('Process output limit exceeded')); else { stderr += data; onStderr?.(data) } })
    child.on('error', (error) => { cleanup(); reject(error) })
    child.on('close', (code) => { cleanup(); failure ? reject(failure) : resolve({ code, stdout, stderr }) })
  })
}

export async function authorizedVideo(input, roots) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw new Error('Provide an absolute local video path')
  if (!Array.isArray(roots) || roots.length === 0) throw new Error('Set allowedRoots in the plugin settings to the video folders you want to read')
  const file = await realpath(input)
  for (const root of roots) {
    let resolved
    try { resolved = await realpath(path.resolve(root)) } catch { continue }
    const relative = path.relative(resolved, file)
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return file
  }
  throw new Error('Video path is outside allowedRoots (symlinks are resolved before checking)')
}

export async function doctor(config = {}) {
  const loc = locations(config)
  if (!existsSync(loc.python)) return { ready: false, reason: 'Python runtime not installed; run the setup command', ...loc }
  const result = await run(loc.python, ['-c', 'import imageio_ffmpeg,av,PIL,faster_whisper;print(imageio_ffmpeg.get_ffmpeg_exe())'])
  return { ready: result.code === 0, baseModelReady: existsSync(path.join(loc.models, 'base/model.bin')), error: result.code ? result.stderr.slice(-2000) : null, ...loc }
}

let setupPending
export function setup(config = {}, options = {}) {
  if (setupPending) return setupPending
  setupPending = setupOnce(config, options).finally(() => { setupPending = undefined })
  return setupPending
}
async function setupOnce(config, { signal, model = 'base', onStderr } = {}) {
  if (!['base', 'small'].includes(model)) throw new Error('Model must be base or small')
  const loc = locations(config)
  await mkdir(loc.root, { recursive: true })
  if (!existsSync(loc.python)) {
    if (config.pythonPath) throw new Error('Configured pythonPath does not exist; provide an absolute interpreter path')
    const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]
    let chosen
    for (const [exe, prefix] of candidates) {
      try { const r = await run(exe, [...prefix, '-c', 'import sys;assert (3,12)<=sys.version_info[:2]<(3,15)'], { signal, timeoutMs: 20_000 }); if (r.code === 0) { chosen = [exe, prefix]; break } } catch (e) { if (signal?.aborted) throw e }
    }
    if (!chosen) throw new Error('Install Python 3.12–3.14 with venv support, then run setup again')
    const r = await run(chosen[0], [...chosen[1], '-m', 'venv', path.join(loc.root, 'venv')], { signal })
    if (r.code) throw new Error(r.stderr.slice(-2000))
  }
  const pip = await run(loc.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(packageRoot, 'python', 'requirements.txt')], { signal, timeoutMs: 1_800_000, onStderr })
  if (pip.code) throw new Error(pip.stderr.slice(-3000) || pip.stdout.slice(-3000))
  const prepared = await run(loc.python, [loc.script, '--prepare-model', '--model', model], { signal, timeoutMs: 1_800_000, env: { DSH_VIDEO_MODELS_DIR: loc.models }, onStderr })
  if (prepared.code) throw new Error(prepared.stderr.slice(-3000))
  return doctor(config)
}

export async function readVideo(args, config = {}, execution = {}) {
  const loc = locations(config)
  const file = await authorizedVideo(args.path, config.allowedRoots)
  if (!existsSync(loc.python)) throw new Error('Runtime missing. Run npx dsh-local-video-reader setup first')
  const frames = args.frames ?? 12
  if (!Number.isInteger(frames) || frames < 1 || frames > 48) throw new Error('frames must be an integer from 1 to 48')
  for (const key of ['start', 'end']) if (args[key] !== undefined && (!Number.isFinite(args[key]) || args[key] < 0)) throw new Error(`${key} must be a non-negative finite number`)
  if (args.end !== undefined && args.end <= (args.start ?? 0)) throw new Error('end must be after start')
  const model = args.model || 'base'
  if (!['base', 'small'].includes(model)) throw new Error('Model must be base or small')
  const command = [loc.script, file, '--frames', String(frames), '--model', model]
  if (args.start !== undefined) command.push('--start', String(args.start))
  if (args.end !== undefined) command.push('--end', String(args.end))
  if (args.language) { if (!/^[a-z]{2,3}$/.test(args.language)) throw new Error('language must be a two or three letter language code'); command.push('--language', args.language) }
  if (args.transcribe === false) command.push('--no-asr')
  const r = await run(loc.python, command, { signal: execution.signal, timeoutMs: config.timeoutMs || 1_200_000, env: { DSH_VIDEO_MODELS_DIR: loc.models, DSH_VIDEO_CACHE_DIR: loc.cache } })
  if (![0, 2].includes(r.code)) throw new Error(r.stderr.slice(-3000) || 'Video processing failed')
  if (!r.stdout.trim()) throw new Error(r.stderr.slice(-3000) || 'Video processor returned no result')
  let manifest
  try { manifest = JSON.parse(r.stdout.trim()) } catch { throw new Error(r.stderr.slice(-3000) || 'Video processor returned invalid JSON') }
  const transcript = await readFile(manifest.transcript_path, 'utf8')
  return { ...manifest, transcript: transcript.slice(0, 60_000), transcriptTruncated: transcript.length > 60_000, nextStep: 'Read the contact_sheets with the host read_image tool, then combine visual evidence with this transcript. The images have NOT been interpreted by this tool. Sampled frames do not cover every moment.' }
}
