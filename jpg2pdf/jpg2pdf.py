#!/usr/bin/env python3
"""긴 이미지(웹툰, 긴 캡처 등)를 A4 등 고정 크기 페이지로 자동 분할해 PDF로 만든다.

- 가로폭을 페이지 본문 폭에 맞추고, 페이지 높이만큼 세로로 자른다.
- 자르는 위치 근처에서 '빈 가로줄(단색 행)'을 찾아 글자/컷이 중간에 잘리지 않게 한다.
- 이미지를 여러 장 주면 순서대로(자연 정렬) 이어 붙여 하나의 긴 이미지처럼 처리한다.
"""
import argparse
import re
import sys
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None  # 아주 긴 이미지 허용

PAGE_SIZES_MM = {"A4": (210, 297), "A5": (148, 210), "B5": (176, 250), "LETTER": (215.9, 279.4)}
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def natural_key(p):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(p))]


def collect_inputs(paths):
    files = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted((f for f in p.iterdir() if f.suffix.lower() in EXTS), key=natural_key)
        else:
            files.append(p)
    return files


def parse_page(spec):
    if spec.upper() in PAGE_SIZES_MM:
        return PAGE_SIZES_MM[spec.upper()]
    m = re.fullmatch(r"(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)", spec.lower())
    if not m:
        raise argparse.ArgumentTypeError("용지는 A4/A5/B5/Letter 또는 '가로x세로'(mm), 예: 200x300")
    return float(m.group(1)), float(m.group(2))


def load_stitched(files, width):
    """모든 이미지를 width px로 맞춰 세로로 이어 붙인다 (RGB, 흰 배경)."""
    parts = []
    for f in files:
        im = ImageOps.exif_transpose(Image.open(f))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.getchannel("A"))
            im = bg
        else:
            im = im.convert("RGB")
        h = max(1, round(im.height * width / im.width))
        parts.append(im.resize((width, h), Image.LANCZOS))
    strip = Image.new("RGB", (width, sum(p.height for p in parts)), "white")
    y = 0
    for p in parts:
        strip.paste(p, (0, y))
        y += p.height
    return strip


def find_cut(gray, target, search, tol, min_y):
    """target 위쪽 search px 범위에서 단색에 가까운 행 중 target에 가장 가까운 행을 찾는다."""
    lo = max(min_y, target - search)
    for y in range(target, lo, -1):
        lo_v, hi_v = gray.crop((0, y - 1, gray.width, y)).getextrema()
        if hi_v - lo_v <= tol:
            return y
    return target


def split_points(strip, page_h, search, tol, smart):
    gray = strip.convert("L")
    cuts, y = [0], 0
    while strip.height - y > page_h:
        target = y + page_h
        cut = find_cut(gray, target, search, tol, y + page_h // 2) if smart else target
        cuts.append(cut)
        y = cut
    cuts.append(strip.height)
    return cuts


def build(files, out, page_mm, margin_mm, dpi, smart, search_ratio, tol, quality):
    px = lambda mm: round(mm / 25.4 * dpi)
    page_w, page_h = px(page_mm[0]), px(page_mm[1])
    m = px(margin_mm)
    body_w, body_h = page_w - 2 * m, page_h - 2 * m
    if body_w <= 0 or body_h <= 0:
        sys.exit("여백이 너무 큽니다.")

    strip = load_stitched(files, body_w)
    cuts = split_points(strip, body_h, int(body_h * search_ratio), tol, smart)

    pages = []
    for top, bottom in zip(cuts, cuts[1:]):
        page = Image.new("RGB", (page_w, page_h), "white")
        page.paste(strip.crop((0, top, body_w, bottom)), (m, m))
        pages.append(page)

    pages[0].save(out, "PDF", resolution=dpi, save_all=True, append_images=pages[1:], quality=quality)
    return len(pages), strip.size


def main():
    ap = argparse.ArgumentParser(description="긴 이미지를 페이지로 자동 분할해 PDF로 변환")
    ap.add_argument("inputs", nargs="+", help="이미지 파일 또는 폴더 (여러 개면 순서대로 이어 붙임)")
    ap.add_argument("-o", "--output", help="출력 PDF (기본: 첫 입력 이름.pdf)")
    ap.add_argument("--page", type=parse_page, default=PAGE_SIZES_MM["A4"], help="용지 (기본 A4)")
    ap.add_argument("--margin", type=float, default=10, help="여백 mm (기본 10)")
    ap.add_argument("--dpi", type=int, default=150, help="해상도 (기본 150)")
    ap.add_argument("--no-smart", action="store_true", help="빈 줄 찾기 없이 고정 높이로 자르기")
    ap.add_argument("--search", type=float, default=0.2, help="빈 줄 탐색 범위(페이지 높이 비율, 기본 0.2)")
    ap.add_argument("--tolerance", type=int, default=8, help="빈 줄 판정 허용 명암 차(0~255, 기본 8)")
    ap.add_argument("--quality", type=int, default=90, help="JPEG 품질 (기본 90)")
    a = ap.parse_args()

    files = collect_inputs(a.inputs)
    if not files:
        sys.exit("입력 이미지가 없습니다.")
    out = a.output or str(files[0].with_suffix(".pdf"))
    n, size = build(files, out, a.page, a.margin, a.dpi, not a.no_smart, a.search, a.tolerance, a.quality)
    print(f"{len(files)}개 이미지 → {n}페이지 ({size[0]}x{size[1]}px) : {out}")


if __name__ == "__main__":
    main()
