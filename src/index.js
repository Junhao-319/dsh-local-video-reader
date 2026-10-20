import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { doctor, readVideo } from './runtime.js'

export const name = 'dsh-local-video-reader'
export const inject = ['tools']
export const Config = Schema.object({
  allowedRoots: Schema.array(String).default([]).description('Video folders this plugin may read. Resolve symlinks before checking.'),
  dataDir: Schema.string().description('Optional private runtime/model/cache folder.'),
  pythonPath: Schema.string().description('Optional existing Python environment with the video dependencies.'),
  timeoutMs: Schema.number().default(1200000).description('Maximum processing time per tool call, in milliseconds.'),
})

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'local_video_doctor',
    description: 'Check local video decoding and offline speech recognition setup. Does not install or download anything.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { try { return JSON.stringify(await doctor(config)) } catch (e) { return JSON.stringify({ ready: false, error: e.message }) } },
  }))
  ctx.tools.register(defineTool({
    name: 'local_video_read',
    description: 'Read a local video: sample timestamped images, extract subtitles, and transcribe dialogue offline. Returns transcript text and image paths. Then use read_image on contact_sheets to actually see the frames and answer using both. No additional cloud API key. For rapid action, re-read a short start/end window with more frames. First run requires CLI setup and configured allowedRoots.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute local video path inside configured allowedRoots.' },
      start: { type: 'number', description: 'Optional start time in seconds.' },
      end: { type: 'number', description: 'Optional end time in seconds.' },
      frames: { type: 'number', description: 'Sample 1–48 frames. Default 12.' },
      transcribe: { type: 'boolean', description: 'Transcribe speech locally, default true.' },
      language: { type: 'string', description: 'Optional language code such as zh/en; automatic by default.' },
      model: { type: 'string', description: 'Installed local Whisper model: base (default) or small.' },
    },
    timeoutMs: config.timeoutMs || 1200000,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { try { return JSON.stringify(await readVideo(args, config, exec), null, 2) } catch (e) { return JSON.stringify({ status: 'failed', error: e.message }) } },
  }))
}
