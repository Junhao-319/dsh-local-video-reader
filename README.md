# dsh-local-video-reader

让 DeepSeek Harness 读取**本地视频画面＋对白**。抽帧、字幕提取和语音识别均在本机执行；使用当前会话的视觉模型理解画面，不另外配置视频 API Key。

> 当前版本：0.1.0。画面采用带时间戳抽帧，不是逐帧动作识别；声音支持语音转写，不包含通用音乐、情绪或音效识别。视觉理解需要当前会话模型支持图片。使用云端会话模型时，读入会话的图片和转写文本仍会发送到该模型提供方。

## 安装

环境：Node.js 22.12+、Python 3.12–3.14（包含 venv）。FFmpeg 不必另装，由 `imageio-ffmpeg` 提供。

```sh
# npm 发布后可直接使用；发布前可以安装本地 .tgz 包
dsh plugin --profile web add dsh-local-video-reader

# 显式准备隔离环境与多语言识别模型（首次联网下载）
npx dsh-local-video-reader setup
npx dsh-local-video-reader doctor
```

在插件设置中把 `allowedRoots` 设为允许读取的视频文件夹，例如 Windows 的 `D:\Videos` 或 macOS/Linux 的 `/home/me/Videos`。默认空列表会拒绝读取，避免插件意外读取其他目录。路径会先解析符号链接，再检查是否位于允许的文件夹内。

重启 DSH 或刷新插件后，新开对话：

> 用 local_video_read 读取 D:/Videos/demo.mp4，结合画面和对白总结视频，标注关键时间点。

若 Web 输入框不接受直接拖入 MP4，把视频的本地绝对路径发到对话中即可。本插件不修改附件上传界面，也不承诺为不支持图片的模型增加视觉能力。

## 工具

| 工具 | 功能 |
| --- | --- |
| `local_video_doctor` | 检查本地运行环境和识别模型，不联网安装 |
| `local_video_read` | 抽帧、生成时间戳拼图、提取内嵌字幕和本地转写 |

`local_video_read` 参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `path` | 必填 | 允许文件夹内的视频绝对路径 |
| `frames` | 12 | 1–48 张均匀采样帧 |
| `start` / `end` | 全片 | 只处理指定秒数区间 |
| `transcribe` | true | 是否转写对白 |
| `language` | 自动 | 可设 `zh`、`en` 等 |
| `model` | base | 已安装的 `base` 或 `small` 模型 |

工具返回转写文本、完整结果路径和 `contact_sheets`。Agent 必须使用宿主 `read_image` 实际查看这些图片，再结合对白回答；工具本身只提取证据。长视频可先 `transcribe=false` 浏览画面，再分段转写。快速动作可对短时间窗提高采样密度。

转写失败时返回 `status: partial`，保留可用画面并明确标记错误；无音轨与未检测到语音分别处理。缓存根据源路径、大小、修改时间和处理参数区分，可重复提问。

## 本地命令行

```sh
npx dsh-local-video-reader read /path/demo.mp4 --allow-root /path
npx dsh-local-video-reader read /path/demo.mp4 --allow-root /path --start 30 --end 45 --frames 24
npx dsh-local-video-reader setup --model small
```

`setup` 会创建专用 Python 虚拟环境并从 PyPI、Hugging Face 下载公开依赖与模型。模型大文件支持断点续传，核对官方大小及 SHA256 后才启用。**视频读取不会联网下载权重或上传媒体。** 模型没准备好时给出明确错误，而非静默退化成完整视频理解。

默认数据目录是 `$DSH_HOME/tools/local-video-reader`（未设置 DSH_HOME 时为 `~/.dsh/tools/local-video-reader`），内含 `venv`、`models` 和 `cache`。升级 npm 包不会覆盖模型和缓存。

可通过 `DSH_VIDEO_READER_HOME` 或插件 `dataDir` 更改数据目录；CLI 可用 `--data-dir PATH`。可用 `pythonPath` / CLI `--python PATH` 指定已有的、安装了所需依赖的解释器。CLI 与 DSH 必须使用相同的数据目录。下载使用系统或环境变量中的代理，不写入全局代理配置。

## 开发与验证

```sh
npm test
npm pack
# 本地运行集成测试时设置 VIDEO_READER_TEST_PYTHON 指向已经安装依赖的环境
# 并把 VIDEO_READER_TEST_MODELS 指向含 base/ 子目录的模型根目录
node --test test/integration.test.mjs
```

发布包只含插件源码、Python 核心、依赖声明和文档。不会打包本机视频、转写、账号配置、虚拟环境或模型权重。宿主工具注册表是 optional peer，不会自动安装另一份 DSH 运行时。

Windows 已做本地功能验证；macOS/Linux 的实际端到端验证状态见发布说明，不能将跨平台路径代码当成实机测试结果。

## License

MIT。FFmpeg、Whisper 和其他依赖遵循各自许可证；FFmpeg 二进制及模型权重不随本 npm 包分发。
