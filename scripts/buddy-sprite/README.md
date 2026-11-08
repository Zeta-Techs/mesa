# 小桌精灵图怎么重孵

项目助手的形象「小桌」是一张逐帧精灵图 `src/assets/buddy/xiaozhuo.webp`（每格 224px，8 列 × 8 行），行表在 `src/buddy-sprite.ts`。
2026-11-09 用户觉得矢量版「没有 Codex 的宠物生动」，拍板用出图模型孵。流程借鉴 OpenAI Codex 的 hatch-pet 技能（Apache-2.0）：
先出一张基准图定长相，每个状态以基准图为参考出一行动作条，再切帧、统一大小和基线、拼成一张图。
没做 hatch-pet 的 16 个朝向和左右走：小桌只待在项目助手面板里，不在桌面上跟着鼠标走。

## 文件

| 文件 | 用途 |
|---|---|
| `base.png` | 基准图（长相的唯一依据，出每一行都带上它） |
| `prompts/base.txt` | 基准图的描述（以旧矢量小桌截图为参考改画） |
| `prompts/<行名>.txt` | 各行动作条的描述 |
| `guide-<帧数>.png` | 帧位排布参考（只告诉模型几格、怎么排，不让画进去） |
| `extract.py` | 切帧：透明底直接用，青色底先抠色去溢色；按连通块分帧，贴着的 z / 热气算进同一帧 |
| `assemble.py` | 拼图：每行按中位身高缩放（带道具的两行按宽度对齐 idle），统一基线，烤米白贴纸边，出 webp 和深浅两张联系表 |

## 步骤

出图走 Mesa 连接页「出图模型」（`mesa_helper image`，密钥由它自己取）。开发机上用编出来的 helper：

```bash
H=src-tauri/target/debug/mesa_helper
D=scripts/buddy-sprite
mkdir -p /tmp/xz-rows
```

各行（行名 / 帧数）：idle 6、waving 4、running 6（在想）、jumping 5（答完蹦）、failed 8（没问成）、sleep 6、idle-coffee 6、idle-lamp 6。每行一条命令，可以并行跑，一条两三分钟：

```bash
$H image --image $D/base.png --image $D/guide-6.png --prompt-file $D/prompts/idle.txt --size 1536x1024 --out /tmp/xz-rows/idle.png
```

拼图并看联系表：

```bash
python3 -I scripts/buddy-sprite/assemble.py /tmp/xz-rows /tmp/xz-sheet.webp
```

逐行看 `/tmp/xz-sheet.contact.jpg`（浅底）和 `/tmp/xz-sheet.dark.jpg`（深底）：表情不对（比如该平静的一帧皱眉）、身子大小或长相和别的行对不上，就重出那一整行，不要从别的批次挑单帧拼进来；
只差一帧时可以在 `assemble.py` 的 `SWAP` 里用同一行的另一帧顶上。没有出格提示、联系表看着对了，再拷到 `src/assets/buddy/xiaozhuo.webp`。
行数、帧数、行顺序变了要同步改 `src/buddy-sprite.ts`，`tests/buddy-sprite.test.ts` 会核对图的尺寸。
