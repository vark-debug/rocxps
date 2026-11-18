# IOPaint + LaMa 本机独立测试指南

> 适用范围：Apple Silicon Mac（M1 Max / 64GB / macOS 26 左右），目标是在本机把 IOPaint + LaMa 跑通，验证“纯移除/填补”效果。**2026-11-04 已接入 rocxps 插件（见 §14）**，本指南其余章节仍是独立的命令行/API 测试流程。
> 核对日期：2026-11-04。
> 版本基线：PyPI 上 `iopaint` 的最新版是 **1.6.0**（2025-03-18 上传），下文所有参数、接口、mask 语义均以该版本源码为准；不确定的地方标 **未验证**。

## 0. 一句话结论

**能跑通，但有两个硬前提：**

1. **必须用 Python 3.11（或 3.10）**，装在独立 venv 里。PyPI 元数据虽然写 `requires-python >=3.7`，但 `iopaint==1.6.0` 把 `Pillow` 死锁在 `9.5.0`；Pillow 9.5.0 没有 cp313/cp314 wheel，macOS arm64 wheel 只到 cp311，Python 3.12 起在 macOS 上没有现成 wheel。你机器上默认的 Python 3.14.5 直接安装会卡在依赖构建上。
2. **LaMa 在 IOPaint 1.6.0 中被明确排除在 MPS 之外**（`MPS_UNSUPPORT_MODELS` 包含 `lama`）。`iopaint start` 路径会在模型初始化时自动回退 CPU，日志打印 `lama not support mps, switch to cpu`；`iopaint run` 路径的 `--device` 会经过 Typer/枚举传参，是否同样触发回退**未验证**。为了结果可复现，两条路径都统一写 `--device=cpu`，按 CPU 推理评估耗时。

另外，LaMa 的能力边界要先说清楚：它只做“擦除/用周围像素填补”，**不能生成新的语义内容**，不能把“椅子”换成“一盆花”。需要替换内容时，要换扩散类 inpainting 模型（如 PowerPaint / SD inpainting），那不是本指南的测试目标。

---

## 1. 版本与事实核对

| 项目 | 核对结果 | 依据（2026-11-04） |
|---|---|---|
| 最新 PyPI 版本 | `iopaint==1.6.0`，2025-03-18 上传 | `https://pypi.org/pypi/iopaint/json` |
| `requires-python` | `>=3.7`（但被依赖实际卡住，见 §2） | PyPI 元数据 |
| 安装包 | `IOPaint-1.6.0-py3-none-any.whl`（纯 Python，约 3.3MB） | PyPI 文件列表 |
| 关键依赖锁 | `Pillow==9.5.0`、`fastapi==0.108.0`、`gradio==4.21.0`、`diffusers==0.27.2`、`huggingface-hub==0.25.2`、`torch>=2.0.0`（不锁上限） | PyPI `requires_dist` |
| LaMa 权重 | `big-lama.pt`，**205,669,692 字节**（约 196MiB），MD5 `e3aa4aaa15225a33ec84f9f4bc47e500` | 权重 URL 的 `Content-Length`；MD5 来自源码常量 |
| 权重 URL | `https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt` | `iopaint/model/lama.py` |
| 默认缓存目录 | `~/.cache/torch/hub/checkpoints/big-lama.pt` | 官方文档 + `helper.py` |
| 服务默认地址 | `127.0.0.1:8080` | `cli.py` 默认值 |
| HTTP 主接口 | `POST /api/v1/inpaint` | `iopaint/api.py` |
| mask 语义 | **白（>=128）= 要编辑；黑（<128）= 保留** | 见 §6.3 的源码出处 |
| LaMa 是否支持 MPS | **否**，`MPS_UNSUPPORT_MODELS` 包含 `"lama"` | `iopaint/const.py` |

> 说明：GitHub 仓库 main 分支的 `api.py / schema.py / const.py / model_manager.py / batch_processing.py / cli.py / helper.py / runtime.py / model/lama.py / model/base.py` 与 PyPI 1.6.0 sdist 逐文件比对一致（仅空行差异），因此下文链接到 main 分支的源码行号对 1.6.0 同样适用。

---

## 2. 安装

### 2.1 为什么不建议装在系统 Python / Homebrew 全局环境

- macOS 自带的 `/usr/bin/python3` 不是给第三方项目装依赖用的；Homebrew 的 Python 受 PEP 668 “externally-managed” 限制，直接 `pip install` 会被拒绝。
- IOPaint 1.6.0 锁了一批**偏旧**的依赖（Pillow 9.5.0、fastapi 0.108.0、gradio 4.21.0、huggingface-hub 0.25.2）。装进全局环境很容易和你其它项目/工具冲突，而且升级其中一个就会把 IOPaint 弄坏。
- 本机默认是 Python 3.14.5；`iopaint` 的 `Pillow==9.5.0` 没有 3.13/3.14 的 wheel，安装会尝试源码构建（大概率失败，**未验证**具体报错）。
- 结论：**给 IOPaint 单独一个 venv，Python 固定 3.11**。这是最省事、最容易排障的方式。

### 2.2 Python 版本选择（按实际 wheel 情况）

| Python | macOS arm64 可行性 | 说明 |
|---|---|---|
| 3.10 | 可用 | Pillow 9.5.0 有 cp310 arm64 wheel；但较新的 torch 要求 >=3.11，解析器只能选较旧 torch |
| **3.11** | **推荐** | Pillow 9.5.0 有 cp311 arm64 wheel；torch 2.6 / 2.15 都有 cp311 arm64 wheel |
| 3.12 | 不建议 | Pillow 9.5.0 只有 Windows 的 cp312 wheel，macOS 需要源码编译，成功率**未验证** |
| 3.13 / 3.14 | 不可用 | Pillow 9.5.0 完全没有 cp313/cp314 wheel；源码构建在 3.13+ 上**未验证**，不建议尝试 |

> 你机器上的 `python3` 是 3.14.5，不要直接用它装。下面用 uv 创建 3.11 环境。

### 2.3 推荐方式 A：uv + 独立 venv

安装 uv（二选一）：

```bash
brew install uv
# 或者官方脚本：
# curl -LsSf https://astral.sh/uv/install.sh | sh
```

创建 Python 3.11 环境并安装：

```bash
uv venv --python 3.11 "$HOME/.venvs/iopaint"
source "$HOME/.venvs/iopaint/bin/activate"

uv pip install iopaint
```

`uv` 会自动下载一份受管理的 CPython 3.11（arm64），不需要你先装 Homebrew Python。

安装后自检：

```bash
uv pip show iopaint
python -c "import sys, torch; print(sys.version); print('torch', torch.__version__, 'mps', torch.backends.mps.is_available())"
iopaint --help
```

预期：`iopaint` 的版本是 `1.6.0`。`mps` 可能是 `True`，但这**不代表 LaMa 会用它**（见 §4、§11）。

### 2.4 方式 B：普通 venv + Homebrew Python 3.11

```bash
brew install python@3.11
"$(brew --prefix python@3.11)/bin/python3.11" -m venv "$HOME/.venvs/iopaint"
source "$HOME/.venvs/iopaint/bin/activate"
python -m pip install --upgrade pip
python -m pip install iopaint
```

venv 内部不受 PEP 668 限制，可以正常安装。

### 2.5 方式 C：pipx（只想要全局 `iopaint` 命令时）

```bash
brew install pipx
pipx install --python "$(brew --prefix python@3.11)/bin/python3.11" iopaint
```

- 优点：命令全局可用，环境仍隔离。
- 缺点：后续要钉 torch 版本、排查依赖时不如 venv 直观；可以用 `pipx inject iopaint torch==2.6.0` 调整。

### 2.6 torch 版本的处理

`iopaint` 只写 `torch>=2.0.0`，没有上限。2026-11 时 PyPI 最新 torch 已经是 2.15.x，而 IOPaint 1.6.0 发布于 2025-03，**未验证**与 2.15 的兼容性。

如果安装后启动时报 torch / TorchScript / numpy 相关错误，优先把 torch 钉到与 IOPaint 1.6.0 同期的版本（torch 2.6.0 有 cp311 arm64 wheel）：

```bash
uv pip install "torch==2.6.0"
```

> 装 LaMa 不需要 torchvision；不要为了“补齐”去乱装 CUDA/ROCm 版本，macOS 上没有意义。

---

## 3. 模型与权重

### 3.1 首次运行是否联网

会。`iopaint start` / `iopaint run` 启动时会先扫描本地模型；如果 `lama` 不在缓存里，会**先下载 196MiB 的 `big-lama.pt`，再启动服务**。所以首次启动会卡在下载阶段，终端能看到 `Downloading: "..."`。

- 能离线：提前把权重放到缓存目录即可，IOPaint 检测到文件存在就不会再下载。
- `--local-files-only` 只影响 HuggingFace 的扩散模型下载（设置 `TRANSFORMERS_OFFLINE=1` / `HF_HUB_OFFLINE=1`），对 LaMa 这个 GitHub Release 权重没有额外作用；离线跑 LaMa 的关键是“文件已经在缓存目录里”。

### 3.2 缓存目录

默认：

```text
~/.cache/torch/hub/checkpoints/big-lama.pt
```

如果你传了 `--model-dir`，IOPaint 会把 `XDG_CACHE_HOME` 指到该目录，于是权重实际在：

```text
<model-dir>/torch/hub/checkpoints/big-lama.pt
```

例如：

```bash
iopaint start --model=lama --device=cpu --model-dir="$HOME/.cache/iopaint-models"
# 对应权重：$HOME/.cache/iopaint-models/torch/hub/checkpoints/big-lama.pt
```

### 3.3 手动下载 / 离线放置

```bash
mkdir -p "$HOME/.cache/torch/hub/checkpoints"
curl -L --retry 3 --progress-bar \
  -o "$HOME/.cache/torch/hub/checkpoints/big-lama.pt" \
  "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"

md5 "$HOME/.cache/torch/hub/checkpoints/big-lama.pt"
# 期望：e3aa4aaa15225a33ec84f9f4bc47e500
```

- 文件大小应为 205,669,692 字节。
- 自动下载完成后，IOPaint 会校验 MD5；不匹配会**删除该文件并报错**。但如果你是手动把文件放进缓存目录，IOPaint 只检查“文件存在”，不会再校验 MD5，所以上面的 `md5` 必须自己跑一遍。
- 国内访问 GitHub Release 慢时，先设代理再 curl，例如 `HTTPS_PROXY=http://127.0.0.1:7890 curl ...`。官方文档也给了百度网盘镜像，但网盘链接的有效性**未验证**。
- 高级用法：源码支持用环境变量 `LAMA_MODEL_URL` 覆盖权重 URL。但 `is_downloaded()` 是按 URL 的 basename 推导缓存路径的，自己改 URL 后离线放置容易踩坑，**未验证**，不建议在首轮测试中使用。

---

## 4. 启动方式一：Web UI

```bash
source "$HOME/.venvs/iopaint/bin/activate"

iopaint start \
  --model=lama \
  --device=cpu \
  --port=8080
```

- `--host` 默认 `127.0.0.1`，只本机可访问；要给局域网访问才用 `--host=0.0.0.0`（注意没有鉴权）。
- `--device` 枚举是 `cpu / cuda / mps`，默认 `cpu`。**对 LaMa 请直接写 `cpu`**；在 `start` 路径下，写 `mps` 也会在模型初始化时被 `switch_mps_device()` 换成 CPU。
- `--model-dir` 见 §3.2。
- 浏览器打开 `http://127.0.0.1:8080`，拖入图片，用画笔涂白要移除的区域，点运行。
- 终端按 `Ctrl+C` 停止。

启动后先验证当前模型：

```bash
curl -s http://127.0.0.1:8080/api/v1/model | jq .
```

期望返回的 `name` 是 `lama`，`model_type` 是 `inpaint`。

> 关于 `--device=mps` 的实际日志：`lama not support mps, switch to cpu`。这不是报错，是主动降级。

---

## 5. 启动方式二：命令行批处理

```bash
iopaint run \
  --model=lama \
  --device=cpu \
  --image="$HOME/iopaint-test/input" \
  --mask="$HOME/iopaint-test/mask" \
  --output="$HOME/iopaint-test/output"
```

参数语义（均已从 1.6.0 源码核对）：

| 参数 | 语义 |
|---|---|
| `--image` | 可以是单张图片，也可以是目录；目录时支持 `.png/.jpg/.jpeg`（大小写不敏感） |
| `--mask` | 可以是目录，也可以是单张 mask；**目录时按文件名 stem 与原图配对**，mask 文件必须与图片同名（扩展名可不同） |
| `--output` | **始终按目录处理**：源码会先 `mkdir`，再写 `<原图stem>.png`；CLI 帮助里写的 “directory or file path” 与 1.6.0 实现不一致，单张图也要给目录 |
| `--device` | 默认 `cpu`，测试请显式写 `cpu`。`mps` 在 LaMa 上不被官方支持，`run` 路径是否触发回退**未验证**；`cuda` 注意：`start` 有 `check_device()` 会在 macOS 降级为 cpu，但 `run` 没有这层检查，`run --device=cuda` 会直接尝试 cuda 并在加载模型时报错（未验证具体异常文本） |
| `--concat` | 输出三张横向拼接图（原图 / mask / 结果）。**注意这会让输出宽度变成 3 倍**，验证像素时不要开 |
| `--config` | 传入 `InpaintRequest` 的 JSON；`run` **没有** `--hd-strategy` 这类单独参数，要改策略只能走 config |

如果你要强制“整图原始分辨率推理”（便于做像素级对比），写一个最小 config：

```bash
cat > /tmp/lama-original.json <<'JSON'
{
  "hd_strategy": "Original",
  "sd_keep_unmasked_area": true
}
JSON

iopaint run \
  --model=lama \
  --device=cpu \
  --image=/path/to/input.png \
  --mask=/path/to/mask.png \
  --output=/tmp/iopaint-out \
  --config=/tmp/lama-original.json
```

注意事项：

- `run` 对尺寸不一致的 mask 会**自动用最近邻缩放到原图尺寸**（源码 `batch_processing.py`）。这看起来“能跑”，但 mask 会被拉歪；API 则是直接 400 拒绝。首轮测试建议保证尺寸完全一致。
- `run` 会把 mask 按 127 二值化，和 API 一致。
- `run` 不支持控制 `hd_strategy` 的 CLI 参数；网上一些教程里的 `--hd-strategy` 对 1.6.0 不成立。
- `iopaint start --config` 是**服务启动配置**（typer-config），不是 `InpaintRequest`；不要和 `run --config` 混用。
- 1.6.0 的 CLI 没有 `dump` 命令（`cli.py` 只注册了 `install-plugins-packages / download / list / run / start / start-web-config`），`--config` 帮助里提到的 dump 是过期描述。手写 JSON 即可。

---

## 6. HTTP API

官方文档站没有找到单独的 HTTP API 页面（`/api` 路径直接 404）；本节参数全部以 1.6.0 源码为准，不依赖记忆或第三方教程。

### 6.1 接口清单（1.6.0）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/inpaint` | 主接口：JSON + base64 图片/mask，返回处理后的图片二进制 |
| GET | `/api/v1/model` | 查询当前模型 |
| POST | `/api/v1/model` | 切换模型，body `{"name":"lama"}` |
| GET | `/api/v1/server-config` | 当前模型列表、插件、采样器等 |
| POST | `/api/v1/adjust_mask` | mask 膨胀/收缩/反相，返回 PNG，适合做边缘外扩 |
| POST | `/api/v1/save_image` | multipart 上传并保存到 `--output-dir`；**不是 inpaint 接口** |
| GET | `/api/v1/inputimage` | 返回 `--input` 指定的图片 |
| POST | `/api/v1/gen-info` | 读取图片里的 SD 生成参数（与 LaMa 无关） |

### 6.2 `/api/v1/inpaint` 请求

- `Content-Type: application/json`
- body 是 `InpaintRequest`，LaMa 真正用到的字段很少：

| 字段 | 类型 | 默认 | LaMa 下的含义 |
|---|---|---|---|
| `image` | string | 无 | 原图 base64；支持裸 base64，也支持 `data:image/png;base64,...` |
| `mask` | string | 无 | mask base64；同样支持 data URI |
| `hd_strategy` | string | `"Crop"` | `"Original"` / `"Resize"` / `"Crop"`，注意首字母大写 |
| `hd_strategy_crop_trigger_size` | int | `800` | Crop 策略触发阈值（长边超过它才裁剪） |
| `hd_strategy_crop_margin` | int | `128` | Crop 时向外扩的上下文边距 |
| `hd_strategy_resize_limit` | int | `1280` | Resize 策略的目标长边 |
| `sd_keep_unmasked_area` | bool | `true` | 是否把 mask 外像素贴回原图；**保持 true** 才能保证 mask 外不变 |

其余 `ldm_steps / sd_steps / prompt / sd_strength / sd_mask_blur ...` 对 LaMa 不生效，传了也会被忽略。

### 6.3 mask 语义：白 = 编辑

这是最容易搞反的地方。1.6.0 的出处有三处，互相印证：

1. `model_manager.py` 的 `__call__` docstring：`mask: [H, W, 1] 255 means area to repaint`  
   https://github.com/Sanster/IOPaint/blob/main/iopaint/model_manager.py#L92-L111
2. `schema.py` 的 `AdjustMaskRequest`：`base64 encoded mask. 255 means area to do inpaint`  
   https://github.com/Sanster/IOPaint/blob/main/iopaint/schema.py#L506-L511
3. `api.py` 在调用模型前做了：`cv2.threshold(mask, 127, 255, THRESH_BINARY)`  
   https://github.com/Sanster/IOPaint/blob/main/iopaint/api.py#L271-L303

因此实际规则是：

- **灰度值 >= 128 → 变成 255 → 参与重绘（白 = 编辑）**
- **灰度值 < 128 → 变成 0 → 保留原像素（黑 = 保留）**
- 不是“黑 = 编辑”。如果你按黑=编辑做 mask，结果会正好相反：该改的地方没改，不该改的地方被重绘。

### 6.4 返回格式

- 成功：HTTP 200，body 是**图片二进制**，不是 JSON。`Content-Type` 跟输入格式走（PNG 输入通常是 `image/png`），并带 `X-Seed` 响应头（LaMa 不用 seed，可忽略）。
- 失败：JSON，形如 `{"error": "...", "detail": "...", "body": "...", "errors": "..."}`。
- mask 尺寸不一致：HTTP 400，`detail` 会写 `Image size(...) and mask size(...) not match.`。
- 输出会保留输入 PNG 的 alpha 通道；EXIF 会先做 `exif_transpose`（见 §11 的“输出尺寸被改”）。
- **没有 multipart 形式的 inpaint**：`/api/v1/inpaint` 只读 JSON base64；multipart 只存在于 `/api/v1/save_image`。所以“文件上传”这种调用方式在 1.6.0 不存在。

### 6.5 可直接粘贴的 curl

先准备两张同尺寸 PNG：`input.png` 与 `mask.png`（白=编辑）。

**小图（几百 KB）直接内联：**

```bash
B64_IMG=$(base64 -i input.png | tr -d '\n')
B64_MSK=$(base64 -i mask.png  | tr -d '\n')

curl -sS -X POST "http://127.0.0.1:8080/api/v1/inpaint" \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"${B64_IMG}\",\"mask\":\"${B64_MSK}\",\"hd_strategy\":\"Original\",\"sd_keep_unmasked_area\":true}" \
  -D /tmp/iopaint-headers.txt \
  -o /tmp/result.png

file /tmp/result.png
grep -i -E "HTTP/|content-type|x-seed" /tmp/iopaint-headers.txt
```

> macOS 的 `base64` 用 `-i` 指定输入文件；Linux 上换成 `base64 -w0 input.png`。

**大图建议走 payload 文件**，避免 base64 字符串超过 shell 的 `ARG_MAX`（macOS 约 1MB，几 MB 的图很容易超）：

```bash
{
  printf '{"image":"'
  base64 -i input.png | tr -d '\n'
  printf '","mask":"'
  base64 -i mask.png | tr -d '\n'
  printf '","hd_strategy":"Original","sd_keep_unmasked_area":true}'
} > /tmp/iopaint-payload.json

curl -sS -X POST "http://127.0.0.1:8080/api/v1/inpaint" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/iopaint-payload.json \
  -w "HTTP %{http_code}, %{content_type}, %{size_download} bytes\n" \
  -o /tmp/result.png
```

**可选：先把 mask 外扩几像素**（对硬边接缝很有用）：

```bash
B64_MSK=$(base64 -i mask.png | tr -d '\n')

curl -sS -X POST "http://127.0.0.1:8080/api/v1/adjust_mask" \
  -H "Content-Type: application/json" \
  -d "{\"mask\":\"${B64_MSK}\",\"operate\":\"expand\",\"kernel_size\":9}" \
  -o /tmp/mask-expanded.png
```

`operate` 取值：`expand` / `shrink` / `reverse`；`kernel_size` 默认 5。

**确认服务与模型：**

```bash
curl -s http://127.0.0.1:8080/api/v1/model | jq .
curl -s http://127.0.0.1:8080/api/v1/server-config | jq '.modelInfos[].name'
```

---

## 7. mask 规范

### 7.1 尺寸

- **必须与原图像素尺寸完全一致（H、W 都要一致）**。
- API：不一致直接 HTTP 400，不会帮你缩。
- `iopaint run`：会自动用最近邻缩放 mask 到原图尺寸。方便，但会把 mask 拉歪；测试时请自己保证一致。

### 7.2 通道与位深

- 服务端会用 `Image.convert("L")` 把 mask 转成灰度，再做 127 二值化。因此：
  - 单通道灰度 PNG：最稳。
  - RGB PNG（黑白图）：也能用，按亮度转灰度。
  - **RGBA / 透明底 PNG：不要用**。`convert("L")` 只看 RGB、不看 alpha；透明区域的 RGB 值不可靠（可能是黑也可能是白），常见结果是“全黑 mask → 什么都没改”，或者边缘出现意想不到的编辑区域。
- 8-bit 即可。16-bit 灰度 PNG 的行为**未验证**，测试阶段不要用。

### 7.3 白黑语义

- 白（>=128）= 编辑；黑（<128）= 保留。见 §6.3。
- 严格说，API 用的是 `cv2.threshold(..., 127, ..., THRESH_BINARY)`，即 **>127 才算白**；`run` 的源码是 `mask >= 127` 置 255，即 127 也算白。只差 127 这一个灰度值，做像素级测试时知道即可。
- PS 的 Alpha 通道（存储选区）默认就是“白 = 选中”，方向正确。

### 7.4 羽化 / 硬边

这是 LaMa 和扩散模型差别最大的地方：

- API 和 `run` 都会在进入模型前**按 127 二值化**，所以 PS 里做的羽化渐变会被压成一条硬边界（大致落在 50% 灰的位置）。
- 擦除模型（LaMa）的路径**不会**应用 `sd_mask_blur`；该参数只在扩散模型的 `forward_pre_process` 里生效。
- 因此：**羽化对 LaMa 没有“软融合”效果**。要减少接缝，正确做法是：
  1. mask 向外扩 2–4 px（`Select > Modify > Expand`，或调用 `/api/v1/adjust_mask` 的 `expand`）；
  2. 结果回 PS 后，用模糊过的 mask 作为图层蒙版做手工软融合（见 §8.4）。
- LaMa 对硬边 mask 的内部填补是正常的；但边界处上下文突变时可能出现一条细缝或颜色跳变，这属于模型特性，不是参数没传对。

### 7.5 mask 形状建议

- 覆盖完整目标（包括阴影、倒影、边缘溢出），再向外扩 2–4 px。
- 不要把 mask 画得过大：LaMa 依赖周围上下文，洞太大时容易糊、出现条纹。
- 多块不连续区域可以放在同一张 mask 里；Crop 策略会按每个轮廓分别裁切处理。
- mask 贴到图片边缘时，模型可用上下文变少，边缘修复质量通常更差，建议留出边距或分两次处理。

---

## 8. 与 Photoshop 配套的手工流程

目标：在 PS 里做选区 → 导出 mask PNG → 原图导出 PNG → IOPaint 跑 → 结果回 PS 手工贴回。

### 8.1 准备

1. 打开原图，确认 `图像 > 模式` 是 **RGB / 8 位/通道**。16 位先转 8 位（测试阶段）。
2. 先 `文件 > 存储副本` 导出一份 **PNG 原图**（RGB，8 位）。不要用 JPEG：JPEG 会重编码，且可能带 EXIF 旋转信息。

### 8.2 做选区并导出 mask（方法 A，推荐：复制通道到新文档）

1. 用对象选择 / 快速选择 / 套索做出要移除的区域。
2. `选择 > 修改 > 扩展`，2–4 px（补偿模型边缘和抗锯齿）。
3. `选择 > 存储选区...` → 文档：当前文档；通道：**新建** → 确定。此时通道面板多出 `Alpha 1`。
4. 打开 `窗口 > 通道`，在 `Alpha 1` 上右键 → **复制通道...** → 文档选 **新建** → 确定。
   - 这会生成一个与原图同像素尺寸的**灰度新文档**，白色就是选区（编辑区）。
5. 在新文档里确认：
   - `图像 > 模式` 显示 **灰度**、**8 位/通道**；
   - 白色 = 要移除的区域，黑色 = 要保留的区域。如果反了，`图像 > 调整 > 反相`。
6. `文件 > 存储副本...` → 格式 **PNG**。
   - 背景必须是实心黑/白，不要透明底；
   - 文件名与输入图保持同一 stem（`run` 的目录模式按文件名配对）。

> 不建议在通道面板里直接对 `Alpha 1` 执行“另存为”：PNG 不支持附加通道，PS 存出来的通常是合成图，不同版本行为还可能不一致。用“复制通道到新文档”最稳。

### 8.3 方法 B：新建灰度文档手工填白

1. `文件 > 新建`：宽高与原图**像素尺寸完全一致**，颜色模式 **灰度**，背景 **黑色**。
2. 回原图，`选择 > 载入选区`（选 `Alpha 1`），或按住 Cmd 点击通道缩略图。
3. 在新文档里 `编辑 > 填充`：白色、正常模式、100%。
4. `文件 > 存储副本` → PNG。

### 8.4 跑 IOPaint 并回贴

1. 用 §4 的 Web UI，或 §5/§6 的命令行/API 跑：
   - 输入：§8.1 导出的 PNG 原图；
   - mask：§8.2/§8.3 导出的灰度 PNG；
   - 建议 `hd_strategy=Original` 做首轮验证，之后再按需改 `Crop`。
2. 在 PS 中打开原图和 `result.png`。
3. 把 `result.png` 作为新图层复制到原文档：
   - 两张图尺寸完全一致时，直接全选复制/粘贴会保持位置；
   - 或用 `文件 > 置入嵌入对象`，确认缩放为 100%、位置 (0,0)。
4. 因为 `sd_keep_unmasked_area=true`，结果图在 mask 外的像素本来就和原图一致，所以硬边贴回通常已经够用。
5. 如果边缘有细缝：
   - 给结果图层添加图层蒙版；
   - 载入 mask 选区（白色=显示结果）；
   - 对蒙版做 1–2 px 高斯模糊（`滤镜 > 模糊 > 高斯模糊`），让结果和原图在边界处过渡；
   - 100% 检查边缘，必要时用修复画笔局部收尾。
6. 合并/导出。若要保留可编辑性，另存 PSD。

> 关键点：mask 的“软边”不要在送给 LaMa 之前做（会被二值化），而是回贴阶段用 PS 图层蒙版做。

---

## 9. 性能预期（M1 Max / 64GB）

### 9.1 先说明：没有官方数字

没有找到 IOPaint 官方给出的 Apple Silicon 性能基准；LaMa 原论文也不是面向 M1 的。下面只给量级判断，**具体数字一律标未验证**，请按 §9.3 自己测。

### 9.2 量级判断

- **LaMa 是单次前向**：没有采样步数、没有 prompt、没有 seed，结果是确定性的。一次请求就是一次网络推理 + 预处理/后处理。
- **CPU 推理**：1K 级别图片通常是“秒级到十秒级”；4K 全图 `hd_strategy=Original` 可能是“数十秒到分钟级”。（**未验证**，取决于 mask 面积、CPU 调度、torch 版本。）
- **MPS 基本不参与**：LaMa 被官方标记为 MPS 不支持，`start` 路径会把 `--device=mps` 换成 CPU，所以 M1 Max 的 GPU 在这条链路上基本是闲置的（`run` 路径**未验证**）。不要拿“GPU 机器”的预期来估。
- **与扩散模型的差别**：扩散 inpainting 要做文本编码 + 20–50 步 UNet，每步都要过一遍网络；CPU 上通常比 LaMa 慢一个数量级以上，而且结果随机（换 seed 会变）。LaMa 的优势是快、稳定、可重复；劣势是不能生成新语义。
- **内存**：权重文件约 196MiB；进程常驻内存预计在 1–2GB 量级（**未验证**）。全分辨率推理的激活值会随像素数增长，4K/8K 原图可能到数 GB；64GB 机器一般不会被 1K–2K 图卡住，但 4K+ `Original` 要实测。
- **启动/加载**：每次 `iopaint run` 命令都会重新加载 196MiB 的 TorchScript 模型；批量处理时用一次 `run` 跑整个目录，避免逐张启动。若改用常驻的 `iopaint start` 服务，模型只在启动时加载一次，连续调 API 不会重复加载。

### 9.3 怎么测（建议直接照做）

**服务端日志（最准的单次推理耗时）：**

`api.py` 每次请求都会打印 `process time: xxx ms`。在启动 `iopaint start` 的终端里看这一行即可，它不含 base64 传输和图片编码时间。

**端到端耗时：**

```bash
time iopaint run \
  --model=lama --device=cpu \
  --image=/path/to/input.png \
  --mask=/path/to/mask.png \
  --output=/tmp/iopaint-out \
  --config=/tmp/lama-original.json
```

**峰值内存（macOS）：**

```bash
/usr/bin/time -l iopaint run \
  --model=lama --device=cpu \
  --image=/path/to/input.png \
  --mask=/path/to/mask.png \
  --output=/tmp/iopaint-out
```

看输出里的 `maximum resident set size`（单位是字节）。

**服务常驻内存：**

```bash
ps -o pid,rss,command -p "$(pgrep -f 'iopaint start' | head -1)"
```

`rss` 单位是 KB。

**建议记录一张表：**

| 图片尺寸 | mask 面积占比 | hd_strategy | 单次耗时 | 峰值 RSS | 备注 |
|---|---|---|---|---|---|
| 1024×1024 | 5% | Original | 待测 | 待测 | |
| 2048×2048 | 5% | Crop（默认） | 待测 | 待测 | |
| 4000×3000 | 10% | Original | 待测 | 待测 | 重点看是否 OOM/换页 |

---

## 10. 验证清单

目标：确认“只改了 mask 内，mask 外像素完全一致”。

### 10.1 前置条件

- 输入、输出都用 **PNG 8-bit**；不要 JPEG（重编码会让全图像素都变）。
- mask 与原图尺寸完全一致。
- API 请求里 `sd_keep_unmasked_area` 保持 `true`。
- 为排除裁剪/缩放干扰，首轮用 `"hd_strategy":"Original"`。

### 10.2 功能检查

1. **模型确认**：`curl -s http://127.0.0.1:8080/api/v1/model | jq .name` 返回 `"lama"`。
2. **全黑 mask 对照**：送一张全黑 mask，结果应与原图逐像素一致（全图 AE=0）。如果这一步就不一致，说明格式/尺寸/透明度有问题。
3. **白矩形 mask**：mask 内应该出现填补，mask 外 AE 必须为 0。
4. **尺寸保护**：故意送一张比原图小 10px 的 mask，API 应返回 HTTP 400；如果返回 200，说明你连的不是 1.6.0 的 `/api/v1/inpaint`。
5. **输出尺寸**：`result.png` 的像素尺寸应与输入完全一致；如果不等，优先查 EXIF 旋转、`--concat`、或 PS 的“图像大小”。
6. **批处理**：用 `run` 跑同一组图，结果与 API 的 mask 外像素也应一致（run 默认 `hd_strategy=Crop`，但 mask 外仍会贴回原图）。

### 10.3 方法 A：Photoshop 差值图层

1. 打开原图和结果图，把结果图作为顶层图层（同尺寸、位置 0,0）。
2. 顶层混合模式改为 **差值**。
3. 加一个 **阈值** 调整层，阈值设为 1（PS 的阈值最小就是 1），任何非零差异都会变成白色。
4. 载入 mask 选区 → 反选 → 给差值层加图层蒙版，只看 mask 外区域。
5. 预期：mask 外全黑；mask 内应有白色差异。若 mask 外出现白点，检查是否用了 JPEG、是否 `sd_keep_unmasked_area=false`、是否输出被重新采样。

### 10.4 方法 B：ImageMagick（需先安装）

```bash
brew install imagemagick

# 全图差异像素数（AE = absolute error，按像素计数）
magick compare -metric AE input.png result.png null: 2>&1

# 只统计 mask 外（把 mask 反相后乘到差异图上）
magick input.png result.png -compose difference -composite \
  \( mask.png -negate \) -compose multiply -composite \
  -alpha off -colorspace Gray -threshold 0 \
  -format "%[fx:mean*w*h]\n" info:
```

最后一行输出 mask 外的差异像素数；期望 `0`。注意 `magick` 是 ImageMagick 7 的命令，本机目前没装。

### 10.5 方法 C：Python 逐像素检查（推荐，最直观）

在 iopaint venv 里执行（自带 Pillow/numpy）：

```python
from PIL import Image
import numpy as np

orig = np.array(Image.open("input.png").convert("RGB")).astype(np.int16)
out  = np.array(Image.open("result.png").convert("RGB")).astype(np.int16)
mask = np.array(Image.open("mask.png").convert("L"))
edit = mask >= 128          # 与 IOPaint 的 127 阈值一致

diff = np.any(np.abs(orig - out) > 0, axis=2)
print("size:", orig.shape[:2], out.shape[:2])
print("changed inside :", int((diff & edit).sum()))
print("changed outside:", int((diff & ~edit).sum()))
```

- `changed outside` 必须为 `0`。
- `changed inside` 应该大于 0；如果为 0，说明 mask 没生效（见 §11）。
- 如果输出是 RGBA，`.convert("RGB")` 会丢掉 alpha；比较 RGB 即可。

---

## 11. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `--device=mps` 没有加速，日志写 `lama not support mps, switch to cpu` | 1.6.0 的 `MPS_UNSUPPORT_MODELS` 明确包含 `lama`；`start` 会强制降级 | 接受 CPU 推理；不要在这条链路上追求 MPS。要 GPU 只能换模型/换工具。`run --device=mps` 的实际行为**未验证**，测试统一用 cpu |
| `mps is not available, use cpu instead` | Python 是 Rosetta/x86_64，或 torch 构建不带 MPS | 用 arm64 的 Python 3.11 重建 venv；`python -c "import platform; print(platform.machine())"` 应为 `arm64` |
| 安装 `iopaint` 时卡在 Pillow / 编译报错 | 用了 Python 3.13/3.14，或无 macOS arm64 wheel 的 3.12 | 换 Python 3.11 的独立 venv；不要试图给 Pillow 9.5.0 强行编译 |
| `torch` 导入错误 / TorchScript 加载错误 / numpy ABI 警告 | 1.6.0 没锁 torch 上限，装到了过新的 torch | `uv pip install "torch==2.6.0"` 后重建环境；确认 venv 内 `torch.__version__` |
| 首次启动卡在下载 / 下载失败 | 需要从 GitHub Release 拉 196MiB | 按 §3.3 手动下载到缓存目录，校验 MD5；代理用 `HTTPS_PROXY` |
| 首次自动下载后报 MD5 不匹配，文件被删 | 下载不完整/被代理改写 | 删残留文件，重新下载，确认 205,669,692 字节；手动放置的文件不会触发该校验，需自己核对 |
| 内存暴涨 / 系统换页 | `hd_strategy=Original` + 4K/8K 全图，激活值很大 | 改用默认 `Crop`、缩小图片、分批跑；用 §9.3 监控 RSS |
| `Address already in use` / 端口占用 | 8080 被旧进程占用 | `lsof -nP -iTCP:8080 -sTCP:LISTEN` 找到 PID 后 `kill`，或 `--port=8081` |
| 输出尺寸/方向变了 | JPEG EXIF 旋转（API 会 `exif_transpose`）；或 `--concat` 三倍宽；或 PS 查看时缩放 | 用 PNG；确认没开 `--concat`；对比 `图像 > 图像大小` 的像素值 |
| mask 完全没生效 | ① 全黑 mask；② 透明底 RGBA（alpha 不被读取）；③ 黑白语义反了；④ 尺寸不一致被 `run` 拉伸；⑤ 16-bit mask | 按 §7 重做 mask：8-bit 灰度、白=编辑、实心背景、尺寸一致；先用全黑/白矩形做对照 |
| mask 内改了，但边缘有一条缝 | LaMa 用硬边 mask，擦除模型不应用 `sd_mask_blur`；羽化在 API 侧被二值化 | mask 外扩 2–4 px；回 PS 用模糊蒙版融合；不要把羽化当成模型参数 |
| 输出整体都变了 | `sd_keep_unmasked_area=false`，或输入是 JPEG 被重编码 | 保持 `true`；用 PNG 输入输出 |
| `iopaint: command not found` | 没激活 venv / pipx 的 bin 不在 PATH | `source ~/.venvs/iopaint/bin/activate`；或把 `~/.local/bin` 加进 PATH |
| `run --config` 改了没效果 | config 字段名/枚举值写错；`hd_strategy` 必须 `Original/Resize/Crop` | 用 §5 的最小 JSON；检查终端打印的 `Using config: ...` |
| `iopaint dump` 不存在 | 1.6.0 CLI 没有 dump 命令 | 手写 `InpaintRequest` JSON；帮助文本里的 dump 是过期描述 |

---

## 12. LaMa 的能力边界

### 12.1 它到底在做什么

LaMa（Resolution-robust Large Mask Inpainting with Fourier Convolutions）是一个**擦除/填补**模型：输入原图 + mask，输出在 mask 区域用周围纹理、结构、颜色“补”出来的图。它是确定性的、单次前向，没有文本条件，也没有“生成新物体”的能力。

### 12.2 不能做什么

- **不能生成新的语义内容**：不能“删掉椅子换一盆花”，不能“把路人换成一只狗”，不能“给天空加一架飞机”。
- 不能理解 prompt；`prompt`、`negative_prompt`、`sd_steps` 这些字段对 LaMa 无效。
- 不能保证大面积缺失区域的结构合理：洞太大时容易糊、出现条纹、颜色渐变不自然。
- 不能精确重建文字、人脸、手部、建筑直线、透视关系。
- 不能提供多个候选结果（没有 seed 采样）；每次结果基本一致。

### 12.3 适合 / 不适合

| 适合 | 不适合 |
|---|---|
| 移除小物体、路人、杂物、水印、文字、划痕、电线 | 需要“换成另一个东西”的语义替换 |
| 背景是草地、墙面、天空、路面、渐变、重复纹理 | 大面积遮挡后需要重建主体结构（人脸/手/建筑） |
| mask 相对目标不大，周围有足够上下文 | mask 覆盖画面很大比例，或目标贴边 |
| 需要快速、可重复、批量处理 | 需要多种风格候选、需要 prompt 控制 |
| 产品图去污点、证件照去杂物、老照片去划痕 | 复杂反射、透明物体、精细毛发边缘、精确文字排版 |

> 如果测试发现“能擦掉但补得糊”，这通常是 LaMa 的模型上限，不是参数问题；如果要“补得合理”，下一步应评估扩散类 inpainting（PowerPaint / SD inpainting），但那会显著增加耗时和不确定性。

---

## 13. 命令速查

```bash
# 环境
uv venv --python 3.11 "$HOME/.venvs/iopaint"
source "$HOME/.venvs/iopaint/bin/activate"
uv pip install iopaint

# 启动 Web UI（LaMa 请用 cpu）
iopaint start --model=lama --device=cpu --port=8080

# 批处理
iopaint run --model=lama --device=cpu \
  --image="$HOME/iopaint-test/input" \
  --mask="$HOME/iopaint-test/mask" \
  --output="$HOME/iopaint-test/output"

# 手动放权重
mkdir -p "$HOME/.cache/torch/hub/checkpoints"
curl -L -o "$HOME/.cache/torch/hub/checkpoints/big-lama.pt" \
  "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
md5 "$HOME/.cache/torch/hub/checkpoints/big-lama.pt"

# API 自检
curl -s http://127.0.0.1:8080/api/v1/model | jq .
curl -s -X POST http://127.0.0.1:8080/api/v1/adjust_mask \
  -H "Content-Type: application/json" \
  -d "{\"mask\":\"$(base64 -i mask.png | tr -d '\n')\",\"operate\":\"expand\",\"kernel_size\":9}" \
  -o mask-expanded.png
```

---

## 14. 接入 rocxps 插件（2026-11-04）

插件里 IOPaint 是独立平台 `iopaint`，与 ComfyUI / Siliconed 同级，**不需要 API Key**。

### 14.1 启动服务

```bash
source "$HOME/.venvs/iopaint/bin/activate"
iopaint start --model=lama --device=cpu --port=18088
```

- 插件默认服务地址 `http://127.0.0.1:18088`，可在「设置 → 生图平台 = IOPaint → 服务地址」修改。
- 设置里的「IOPaint 模型」可选 `lama` / `mat`。IOPaint 的「当前模型」是**服务端全局状态**，
  `/api/v1/inpaint` 请求体里没有 `model` 字段，因此插件在生成前会先 `GET /api/v1/model`，
  不一致时 `POST /api/v1/model` 切换（首次切换需要加载权重，可能等几秒）。
- 因为模型切换是全局的，插件把 IOPaint 按**单队列**执行（设置里的「生成并发数」对它无效）。

### 14.2 插件内的数据流

1. 捕获选区，发送区域按 32 对齐扩展（与其它平台一致）；**不做缩放**。
2. 原图 = 捕获后的整块 PNG；蒙版 = 同一几何、同一尺寸的灰度 PNG（白 = 编辑，黑 = 保留）。
   两者天然同尺寸；插件还会在本地校验尺寸与「全黑 / 全白」，避免必然失败的请求。
3. `POST /api/v1/inpaint`（JSON + base64，`hd_strategy=Crop`、`sd_keep_unmasked_area=true`），
   返回图片二进制 → base64。
4. 结果按 `explicitSize:false` 路径贴回；默认仍是「图层蒙版」，结果图只在蒙版内变化，
   整块贴回 + 整画布蒙版安全。

### 14.3 常见错误与提示

| 现象 | 插件提示 | 处理 |
|---|---|---|
| 服务未启动（ECONNREFUSED） | 未连接 IOPaint（地址）…请先在终端启动服务：`iopaint start --model=… --device=cpu --port=…` | 按提示启动服务，或在设置里改端口 |
| 模型未下载 | HTTP 500 + 服务端 detail；「测试连接」会列出已安装模型 | 先 `iopaint download --model=mat`，或用已安装的模型 |
| 蒙版尺寸不符 | 蒙版尺寸（a×b）与发送原图（c×d）不一致 | 重新抓取选区（插件自动保证同尺寸） |
| 全黑 / 全白蒙版 | 蒙版全黑：没有需要编辑的区域；蒙版全白：整块都会被重绘 | 调整选区（白色才是要擦除的区域） |
| 400 + `not match` | 蒙版尺寸与原图不一致（服务端原文） | 同上，重新抓取 |
| 长边很大的图很慢 / 内存高 | 超时（默认上限 120s） | 缩小选区；或改用其它平台 |

### 14.4 验证（插件内）

1. 服务启动后，设置页选 IOPaint，点「测试连接」→ 应显示「已连接 IOPaint（当前模型 …）」。
2. 在主面板框选要擦除的物体 → 生成：历史条目「平台 IOPaint（本地擦除）」。
3. 贴回后对比：蒙版外像素应与原图一致（服务端 `sd_keep_unmasked_area=true`）。
4. 反向用例：`Ctrl+C` 停掉服务后再生成 → 立即失败并给出启动命令，不产生半成品图层。

---

## 15. 参考（2026-11-04 核对）

- PyPI 元数据（版本/依赖/requires-python）：https://pypi.org/pypi/iopaint/json
- IOPaint README（Web UI / run 的官方示例）：https://github.com/Sanster/IOPaint#quick-start
- 官方安装文档：https://www.iopaint.com/install
- 官方模型下载文档（缓存目录 / 手动下载）：https://www.iopaint.com/install/download_model
- LaMa 模型页：https://www.iopaint.com/models/erase/lama
- 源码 `api.py`（`/api/v1/inpaint`、127 阈值、尺寸校验、二进制返回）：https://github.com/Sanster/IOPaint/blob/main/iopaint/api.py
- 源码 `schema.py`（`InpaintRequest`、`mask 255 means area to do inpaint`）：https://github.com/Sanster/IOPaint/blob/main/iopaint/schema.py
- 源码 `model_manager.py`（`255 means area to repaint`）：https://github.com/Sanster/IOPaint/blob/main/iopaint/model_manager.py
- 源码 `const.py`（`MPS_UNSUPPORT_MODELS` 含 `lama`）：https://github.com/Sanster/IOPaint/blob/main/iopaint/const.py
- 源码 `model/lama.py`（权重 URL / MD5 / pad_mod=8）：https://github.com/Sanster/IOPaint/blob/main/iopaint/model/lama.py
- 源码 `batch_processing.py`（run 的 mask 自动缩放与二值化）：https://github.com/Sanster/IOPaint/blob/main/iopaint/batch_processing.py
- 源码 `cli.py`（start / run 参数）：https://github.com/Sanster/IOPaint/blob/main/iopaint/cli.py
- 源码 `helper.py`（MPS 降级、缓存路径、base64 解码、EXIF）：https://github.com/Sanster/IOPaint/blob/main/iopaint/helper.py
- 源码 `runtime.py`（`--model-dir` 与设备检查）：https://github.com/Sanster/IOPaint/blob/main/iopaint/runtime.py
- Pillow 9.5.0 wheel 列表（验证 cp313/cp314 缺失）：https://pypi.org/project/Pillow/9.5.0/#files
