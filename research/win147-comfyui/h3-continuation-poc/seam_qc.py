#!/usr/bin/env python3
"""Seam QC between two adjacent H3 segments.

Usage: python3 seam_qc.py <parent.mp4> <child.mp4> <out_dir> <label>

Metrics:
- boundary frame PSNR/SSIM (parent last frame vs child first frame)
- freeze detection across seam window (freezedetect on concat of last 1s + first 1s)
- scene-change score at the cut (scdet on seam window)
- audio: RMS level (dB) of last 0.5s of parent vs first 0.5s of child,
  plus ebur128 momentary loudness across the seam window
- seam frame PNGs exported to out_dir for human review
"""
import json
import os
import re
import subprocess
import sys


def run(cmd, capture=True):
    p = subprocess.run(cmd, capture_output=capture, text=True)
    return p


def duration(path):
    p = run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", path])
    return float(p.stdout.strip())


def has_audio(path):
    p = run(["ffprobe", "-v", "quiet", "-select_streams", "a",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", path])
    return "audio" in p.stdout


def rms_db(path, start, dur):
    p = run(["ffmpeg", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", path,
             "-vn", "-af", "astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level",
             "-f", "null", "-"])
    vals = [float(m.group(1)) for m in
            re.finditer(r"RMS_level[= ](-?[\d.]+)", p.stderr)]
    return vals[0] if vals else None


def main():
    parent, child, out_dir, label = sys.argv[1:5]
    os.makedirs(out_dir, exist_ok=True)
    dp, dc = duration(parent), duration(child)
    res = {"label": label, "parent": os.path.basename(parent),
           "child": os.path.basename(child),
           "parent_duration_s": round(dp, 3), "child_duration_s": round(dc, 3)}

    # 1. seam frames: last 3 of parent, first 3 of child
    for name, src, ss in [(f"{label}_parent_tail", parent, max(0, dp - 3 / 24)),
                          (f"{label}_child_head", child, 0)]:
        run(["ffmpeg", "-y", "-v", "quiet", "-ss", f"{ss:.4f}", "-i", src,
             "-frames:v", "3", os.path.join(out_dir, name + "_%d.png")])

    # 2. boundary frame PSNR/SSIM
    p_last = os.path.join(out_dir, "_plast.png")
    c_first = os.path.join(out_dir, "_cfirst.png")
    run(["ffmpeg", "-y", "-v", "quiet", "-sseof", "-0.042", "-i", parent,
         "-frames:v", "1", p_last])
    run(["ffmpeg", "-y", "-v", "quiet", "-i", child, "-frames:v", "1", c_first])
    p = run(["ffmpeg", "-i", p_last, "-i", c_first,
             "-lavfi", "psnr", "-f", "null", "-"])
    m = re.search(r"average:([\d.inf]+)", p.stderr)
    res["boundary_psnr_db"] = m.group(1) if m else None
    p = run(["ffmpeg", "-i", p_last, "-i", c_first,
             "-lavfi", "ssim", "-f", "null", "-"])
    m = re.search(r"All:([\d.]+)", p.stderr)
    res["boundary_ssim"] = m.group(1) if m else None

    # 3. seam window concat (last 1s parent + first 1s child) -> freeze & scdet
    seam = os.path.join(out_dir, f"{label}_seam_window.mp4")
    run(["ffmpeg", "-y", "-v", "quiet",
         "-ss", f"{max(0, dp - 1):.3f}", "-i", parent,
         "-t", "1.0", "-i", child,
         "-filter_complex",
         "[0:v][1:v]concat=n=2:v=1:a=0[v]",
         "-map", "[v]", "-c:v", "libx264", "-crf", "18", seam])
    p = run(["ffmpeg", "-i", seam, "-vf",
             "freezedetect=n=-55dB:d=0.25", "-an", "-f", "null", "-"])
    res["freeze_events"] = re.findall(r"freeze_start: [\d.]+", p.stderr)
    p = run(["ffmpeg", "-i", seam, "-vf",
             "scdet=threshold=10,metadata=print:key=lavfi.scdet.score",
             "-an", "-f", "null", "-"])
    scores = [float(m.group(1)) for m in
              re.finditer(r"scdet\.score=([\d.]+)", p.stderr)]
    res["scdet_max_score"] = max(scores) if scores else None
    res["scdet_scores_near_cut"] = scores[20:28] if len(scores) > 24 else scores

    # 4. audio seam
    res["parent_has_audio"] = has_audio(parent)
    res["child_has_audio"] = has_audio(child)
    if res["parent_has_audio"] and res["child_has_audio"]:
        res["parent_tail_rms_db"] = rms_db(parent, max(0, dp - 0.5), 0.5)
        res["child_head_rms_db"] = rms_db(child, 0, 0.5)
        # loudness across seam on audio concat
        p = run(["ffmpeg", "-ss", f"{max(0, dp - 1):.3f}", "-i", parent,
                 "-t", "1.0", "-i", child, "-filter_complex",
                 "[0:a][1:a]concat=n=2:v=0:a=1,ebur128=peak=true",
                 "-f", "null", "-"])
        m = re.findall(r"I:\s+(-?[\d.]+) LUFS", p.stderr)
        res["seam_integrated_lufs"] = m[-1] if m else None
        m = re.search(r"Peak:\s+(-?[\d.]+) dBFS", p.stderr)
        res["seam_true_peak_dbfs"] = m.group(1) if m else None

    for f in (p_last, c_first):
        os.path.exists(f) and os.remove(f)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    json.dump(res, open(os.path.join(out_dir, f"{label}_seam.json"), "w"),
              indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
