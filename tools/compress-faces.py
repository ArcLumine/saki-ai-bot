# -*- coding: utf-8 -*-
"""
压缩表情库里**过大的**表情（2026-09-21）。

## 为什么要这个
用户反馈「有时候发表情包会发送失败」。排查结论：表情以 **base64 内联**发给
NapCat（`file://` 实测不可靠），base64 让体积**再涨约 33%** —— 一张 1.9MB 的
GIF 实际发出去是 ~2.5MB 的字符串，**QQ 会静默丢弃**（NapCat 回 ok、日志无报错，
但群里看不到图）。

所以把超过阈值的表情**就地缩小**（原图先备份），让它们能真正发出去。

## 规则
- 只处理 `library/` 下、`index.json` 里登记过的、**大于 THRESHOLD** 的文件。
- 备份到 `library/_oversized_backup/`（同名，第二次运行不覆盖已有备份）。
- 动图（GIF）：**逐帧缩放**（宽 ≤ MAX_W），并逐步「减色 + 抽帧」直到 < THRESHOLD。
- 静图（png/jpg）：缩放 + 降质量，直到 < THRESHOLD。
- 打印每张的前后大小。

用法：`python tools/compress-faces.py`
"""
import json
import os
import shutil
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'library')
INDEX = os.path.join(LIB, 'index.json')
BACKUP = os.path.join(LIB, '_oversized_backup')

# ⚠️ 和 faces.js 的 PREFER_MAX_BYTES 保持一致（400KB）
THRESHOLD = 400 * 1024
# 表情不需要很大：宽度压到 240 就够 QQ 里显示
MAX_W = 240


def kb(n):
    return round(n / 1024, 1)


def load_files():
    """index.json 里登记、且真实存在的文件名（去重）"""
    with open(INDEX, 'r', encoding='utf-8') as f:
        j = json.load(f)
    names = []
    seen = set()
    for face in j.get('faces', []):
        fn = face.get('file')
        if not fn or fn in seen:
            continue
        seen.add(fn)
        p = os.path.join(LIB, fn)
        if os.path.exists(p):
            names.append(fn)
    return names


def backup(path, name):
    os.makedirs(BACKUP, exist_ok=True)
    dst = os.path.join(BACKUP, name)
    if not os.path.exists(dst):
        shutil.copy2(path, dst)
    return dst


def save_gif_under(im, path, frames, threshold):
    """动图：逐步减色 + 抽帧，直到 < threshold 或实在压不动"""
    # 候选策略：从"保真"到"狠压"，逐个试，第一个达标的就用
    attempts = []
    for colors in (128, 96, 64, 48, 32):
        for step in (1, 2, 3):
            attempts.append((colors, step))
    best = None
    for colors, step in attempts:
        use = frames[::step]
        if len(use) < 2:
            use = frames[:2]
        try:
            use[0].save(
                path,
                save_all=True,
                append_images=use[1:],
                duration=im.info.get('duration', 100),
                loop=im.info.get('loop', 0),
                optimize=True,
                colors=colors,
            )
        except Exception as e:
            print('    gif 保存失败:', e)
            continue
        size = os.path.getsize(path)
        if best is None or size < best[0]:
            best = (size, colors, step)
        if size < threshold:
            return size, colors, step
    # 都压不到阈值 → 用最小的那版
    colors, step = best[1], best[2]
    use = frames[::step] or frames[:2]
    use[0].save(
        path,
        save_all=True,
        append_images=use[1:],
        duration=im.info.get('duration', 100),
        loop=im.info.get('loop', 0),
        optimize=True,
        colors=colors,
    )
    return os.path.getsize(path), colors, step


def compress_gif(path, threshold):
    im = Image.open(path)
    frames = []
    for i in range(getattr(im, 'n_frames', 1)):
        im.seek(i)
        fr = im.convert('RGBA')
        w, h = fr.size
        if w > MAX_W:
            nh = max(1, round(h * MAX_W / w))
            fr = fr.resize((MAX_W, nh), Image.LANCZOS)
        # 转成调色板（GIF 必须），保留透明
        frames.append(fr.convert('P', palette=Image.ADAPTIVE, colors=128))
    im2 = Image.open(path)  # 拿 duration/loop
    size, colors, step = save_gif_under(im2, path, frames, threshold)
    return size, colors, step, len(frames)


def compress_still(path, threshold):
    im = Image.open(path)
    fmt = im.format or 'PNG'
    w, h = im.size
    if w > MAX_W:
        nh = max(1, round(h * MAX_W / w))
        im = im.resize((MAX_W, nh), Image.LANCZOS)
    # 静态图：存成 png（可能带透明），必要时转 jpg
    if fmt == 'GIF':
        fmt = 'PNG'
    if fmt in ('JPEG', 'JPG'):
        im.convert('RGB').save(path, 'JPEG', quality=80, optimize=True)
    else:
        # png：减色能大幅降体积
        im.convert('RGBA').save(path, 'PNG', optimize=True)
    return os.path.getsize(path)


def main():
    if not os.path.exists(INDEX):
        print('找不到 library/index.json')
        return 1
    names = load_files()
    targets = []
    for n in names:
        p = os.path.join(LIB, n)
        if os.path.getsize(p) > THRESHOLD:
            targets.append(n)
    if not targets:
        print('没有超过 %s KB 的表情' % kb(THRESHOLD))
        return 0
    print('要处理 %d 张（阈值 %s KB）' % (len(targets), kb(THRESHOLD)))
    for n in targets:
        p = os.path.join(LIB, n)
        before = os.path.getsize(p)
        bk = backup(p, n)
        ext = os.path.splitext(n)[1].lower()
        try:
            if ext == '.gif':
                after, colors, step, nf = compress_gif(p, THRESHOLD)
                print('  %-38s %8sKB -> %8sKB  (colors=%d step=%d frames=%d)'
                      % (n, kb(before), kb(after), colors, step, nf))
            else:
                after = compress_still(p, THRESHOLD)
                print('  %-38s %8sKB -> %8sKB' % (n, kb(before), kb(after)))
        except Exception as e:
            # 压缩失败 → 还原备份，绝不留半张坏图
            shutil.copy2(bk, p)
            print('  %-38s 失败（已还原）：%s' % (n, e))
    print('\n原图备份在：%s' % BACKUP)
    return 0


if __name__ == '__main__':
    sys.exit(main())