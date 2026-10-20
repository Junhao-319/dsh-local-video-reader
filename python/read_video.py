"""Local video evidence: sampled frames, subtitles and offline speech transcription."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

ROOT = Path(os.environ.get('DSH_HOME', str(Path.home() / '.dsh')))
MODELS = Path(os.environ.get('DSH_VIDEO_MODELS_DIR', str(ROOT / 'tools' / 'local-video-reader' / 'models')))
CACHE = Path(os.environ.get('DSH_VIDEO_CACHE_DIR', str(ROOT / 'cache' / 'video-reader')))

def stamp(t, srt=False):
    ms = max(0, round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02}:{m:02}:{s:02}' + (f',{ms:03}' if srt else f'.{ms:03}')

def run_ffmpeg(args, timeout=120):
    import imageio_ffmpeg
    p = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-nostdin', '-loglevel', 'error', *map(str, args)], capture_output=True, timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if p.returncode:
        raise RuntimeError(p.stderr.decode('utf-8', 'replace')[-2500:])

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def prepare_model(name):
    import time
    import urllib.request
    repo = 'Systran/faster-whisper-' + name
    def fetch_json(url):
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.load(response)
    revision = 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66' if name == 'base' else fetch_json('https://huggingface.co/api/models/' + repo)['sha']
    files = fetch_json(f'https://huggingface.co/api/models/{repo}/tree/{revision}')
    folder = MODELS / name
    folder.mkdir(parents=True, exist_ok=True)
    required = {'config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'vocabulary.json', 'preprocessor_config.json', 'README.md'}
    def digest(path):
        sha = hashlib.sha256()
        with path.open('rb') as handle:
            for block in iter(lambda: handle.read(1024*1024), b''):
                sha.update(block)
        return sha.hexdigest()
    for item in files:
        filename = item.get('path')
        if filename not in required:
            continue
        target = folder / filename
        size = item['size']
        expected = item.get('lfs', {}).get('oid')
        if target.is_file() and target.stat().st_size == size and (not expected or digest(target) == expected):
            continue
        part = folder / (filename + '.download')
        last_error = None
        for attempt in range(6):
            offset = part.stat().st_size if part.is_file() else 0
            if offset > size:
                part.write_bytes(b'')
                offset = 0
            if offset == size:
                if expected and digest(part) != expected:
                    part.write_bytes(b'')
                    offset = 0
                else:
                    part.replace(target)
                    break
            try:
                url = f'https://huggingface.co/{repo}/resolve/{revision}/{filename}?download=true&fresh={time.time_ns()}'
                request = urllib.request.Request(url, headers={'Range': f'bytes={offset}-'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    if response.status == 206:
                        content_range = response.headers.get('Content-Range', '')
                        if not content_range.startswith(f'bytes {offset}-') or not content_range.endswith(f'/{size}'):
                            raise RuntimeError('Unexpected range response: ' + content_range)
                    elif response.status == 200:
                        offset = 0
                    else:
                        raise RuntimeError(f'HTTP {response.status}')
                    with part.open('ab' if offset else 'wb') as handle:
                        downloaded = offset
                        reported = offset
                        while True:
                            block = response.read(1024*1024)
                            if not block:
                                break
                            downloaded += len(block)
                            if downloaded > size:
                                raise RuntimeError('Server sent more bytes than expected')
                            handle.write(block)
                            if downloaded-reported >= 20*1024*1024:
                                handle.flush()
                                print(f'{filename}: {downloaded//1048576}/{size//1048576} MiB', file=sys.stderr, flush=True)
                                reported = downloaded
                if part.stat().st_size != size:
                    raise RuntimeError(f'Incomplete download: {part.stat().st_size}/{size} bytes')
                if expected and digest(part) != expected:
                    part.write_bytes(b'')
                    raise RuntimeError('Model SHA256 mismatch; retrying from byte 0')
                part.replace(target)
                break
            except Exception as error:
                last_error = error
                print(f'{filename}: retry {attempt+1}/6: {error}', file=sys.stderr, flush=True)
        if not target.is_file() or target.stat().st_size != size:
            raise RuntimeError(f'Could not download {filename}: {last_error}')
    from faster_whisper import WhisperModel
    WhisperModel(str(folder), device='cpu', compute_type='int8', local_files_only=True)
    write_json(folder / 'download-verification.json', {'repository': repo, 'revision': revision, 'model_sha256': digest(folder / 'model.bin')})
    print(json.dumps({'model': name, 'path': str(folder), 'ready': True}))

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('video', nargs='?')
    p.add_argument('--start', type=float, default=0)
    p.add_argument('--end', type=float)
    p.add_argument('--frames', type=int, default=12)
    p.add_argument('--model', choices=['base', 'small'], default='base')
    p.add_argument('--language', default=None, help='e.g. zh, en; omitted means auto')
    p.add_argument('--no-asr', action='store_true')
    p.add_argument('--out')
    p.add_argument('--force', action='store_true')
    p.add_argument('--prepare-model', action='store_true')
    a = p.parse_args()
    if a.prepare_model:
        prepare_model(a.model)
        return 0
    if not a.video:
        p.error('video path is required')
    if not 1 <= a.frames <= 48:
        p.error('--frames must be between 1 and 48')
    source = Path(a.video).expanduser().resolve(strict=True)
    if not source.is_file():
        p.error('input must be a local file')
    import av
    with av.open(str(source)) as c:
        duration = float(c.duration / av.time_base) if c.duration else 0
        video = next(iter(c.streams.video), None)
        if video is None:
            raise ValueError('Input contains no video stream')
        if duration <= 0 and video.duration is not None:
            duration = float(video.duration * video.time_base)
        width, height = video.width, video.height
        audio_present = bool(c.streams.audio)
        subtitle_streams = [{'index': s.index, 'codec': s.codec_context.name} for s in c.streams.subtitles]
    if duration <= 0:
        raise ValueError('Could not determine finite video duration')
    start, end = a.start, duration if a.end is None else min(a.end, duration)
    if not 0 <= start < end:
        p.error('--start/--end must describe a non-empty interval inside the video')
    st = source.stat()
    identity = json.dumps([str(source), st.st_size, st.st_mtime_ns, start, end, a.frames, a.model, a.language, a.no_asr, 1])
    key = hashlib.sha256(identity.encode()).hexdigest()[:20]
    out = Path(a.out).expanduser().resolve() if a.out else CACHE / key
    out.mkdir(parents=True, exist_ok=True)
    manifest_file = out / 'manifest.json'
    if manifest_file.exists() and not a.force:
        old = json.loads(manifest_file.read_text(encoding='utf-8'))
        paths = old.get('contact_sheets', []) + [f['path'] for f in old.get('frames', [])]
        if old.get('cache_key') == key and old.get('status') == 'complete' and paths and all(Path(f).is_file() for f in paths) and Path(old.get('transcript_path', '')).is_file():
            print(json.dumps({'manifest': str(manifest_file), 'cache_hit': True, **old}, ensure_ascii=False))
            return 0
    report = {'cache_key': key, 'source': str(source), 'duration_seconds': duration, 'analyzed_start': start, 'analyzed_end': end, 'width': width, 'height': height, 'audio_present': audio_present, 'frames': [], 'contact_sheets': [], 'subtitles': [], 'status': 'processing', 'warnings': [], 'processing': 'local; no media is uploaded by this script'}
    write_json(manifest_file, report)
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 18)
    except OSError:
        font = ImageFont.load_default()
    count = min(a.frames, max(1, math.ceil((end-start) * 2)))
    for i in range(count):
        t = start + (i + 0.5) * (end-start) / count
        frame = out / f'frame-{i+1:03d}.jpg'
        run_ffmpeg(['-y', '-ss', f'{t:.6f}', '-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', '3', frame])
        if not frame.is_file():
            report['warnings'].append(f'No decodable frame at {stamp(t)}')
            continue
        report['frames'].append({'seconds': round(t, 3), 'time': stamp(t), 'path': str(frame)})
    if not report['frames']:
        raise RuntimeError('No frames could be decoded')
    for offset in range(0, len(report['frames']), 12):
        chunk = report['frames'][offset:offset+12]
        canvas = Image.new('RGB', (1280, math.ceil(len(chunk)/3)*280), '#151515')
        draw = ImageDraw.Draw(canvas)
        for j, item in enumerate(chunk):
            x, y = (j % 3)*426, (j // 3)*280
            with Image.open(item['path']) as im:
                thumb = ImageOps.contain(im.convert('RGB'), (418, 244))
                canvas.paste(thumb, (x+(426-thumb.width)//2, y+(244-thumb.height)//2))
            draw.text((x+8, y+250), f"#{offset+j+1:02} {item['time']}", fill='white', font=font)
        sheet = out / f'contact-sheet-{offset//12+1:02d}.jpg'
        canvas.save(sheet, quality=90)
        report['contact_sheets'].append(str(sheet))
    for i, stream in enumerate(subtitle_streams[:3]):
        if stream['codec'] not in ('subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'):
            continue
        sub = out / f'embedded-subtitle-{i+1}.srt'
        try:
            run_ffmpeg(['-y', '-i', source, '-map', f"0:{stream['index']}", '-c:s', 'srt', sub])
            report['subtitles'].append(str(sub))
        except Exception as exc:
            report['warnings'].append('Subtitle extraction: ' + str(exc))
    transcript = out / 'transcript.md'
    report['transcript_path'] = str(transcript)
    segments_json = []
    transcript.write_text('# Local speech transcript\n\n', encoding='utf-8')
    asr_failed = False
    if a.no_asr:
        report['asr_status'] = 'not_requested'
        transcript.write_text('Speech recognition was not requested.\n', encoding='utf-8')
    elif not audio_present:
        report['asr_status'] = 'no_audio_stream'
        transcript.write_text('No audio stream in this video.\n', encoding='utf-8')
    else:
        try:
            audio = out / 'audio-16k.wav'
            run_ffmpeg(['-y', '-ss', start, '-i', source, '-t', end-start, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio], timeout=max(120, (end-start)*0.25))
            from faster_whisper import WhisperModel
            model_dir = MODELS / a.model
            if not (model_dir / 'model.bin').is_file():
                raise RuntimeError(f'Model not installed. Run this script with --prepare-model --model {a.model}')
            print('Transcribing locally (CPU int8)...', file=sys.stderr, flush=True)
            model = WhisperModel(str(model_dir), device='cpu', compute_type='int8', cpu_threads=min(8, os.cpu_count() or 4), local_files_only=True)
            # Feed PCM directly: PyAV 19 removed a keyword still used by older
            # faster-whisper audio decoders. This also bounds RAM for long clips.
            import wave
            import numpy as np
            detected_language = a.language
            with transcript.open('a', encoding='utf-8') as handle:
                with wave.open(str(audio), 'rb') as wav:
                    if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                        raise RuntimeError('Expected mono PCM16 audio at 16000 Hz')
                    chunk_start = 0
                    while True:
                        pcm = wav.readframes(16000*300)
                        if not pcm:
                            break
                        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
                        segments, info = model.transcribe(samples, language=detected_language, beam_size=5, vad_filter=True, condition_on_previous_text=False)
                        detected_language = detected_language or info.language
                        for seg in segments:
                            item = {'start': round(start+chunk_start+seg.start, 3), 'end': round(start+chunk_start+seg.end, 3), 'text': seg.text.strip()}
                            segments_json.append(item)
                            handle.write(f"[{stamp(item['start'])} --> {stamp(item['end'])}] {item['text']}\n")
                            handle.flush()
                        chunk_start += len(samples)/16000
            if not segments_json:
                with transcript.open('a', encoding='utf-8') as handle:
                    handle.write('No speech detected; this is not a verified silent recording.\n')
            report['asr_status'] = 'complete'
            report['asr_language'] = detected_language
            report['asr_model'] = a.model
            report['asr_segments'] = len(segments_json)
            srt_path = out / 'transcript.srt'
            srt_path.write_text('\n\n'.join(f"{i+1}\n{stamp(s['start'], True)} --> {stamp(s['end'], True)}\n{s['text']}" for i, s in enumerate(segments_json)), encoding='utf-8')
            report['transcript_srt'] = str(srt_path)
        except Exception as exc:
            asr_failed = True
            report['asr_status'] = 'failed'
            report['warnings'].append('Speech recognition failed: ' + str(exc))
            transcript.write_text('Speech recognition failed: ' + str(exc) + '\n', encoding='utf-8')
    write_json(out / 'transcript.json', segments_json)
    report['status'] = 'partial' if asr_failed else 'complete'
    write_json(manifest_file, report)
    print(json.dumps({'manifest': str(manifest_file), 'cache_hit': False, **report}, ensure_ascii=False))
    return 2 if asr_failed else 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
