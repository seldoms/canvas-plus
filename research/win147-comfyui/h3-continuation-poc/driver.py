#!/usr/bin/env python3
"""H3 continuation POC driver: submit segment jobs to 147 ComfyUI, one at a time.

Usage:
  python3 driver.py wait-idle            # block until queue empty
  python3 driver.py submit <meta.json>   # build wf from meta, submit, print prompt_id
  python3 driver.py status <prompt_id>   # print history status
  python3 driver.py download <prompt_id> <out.mp4>  # download output video
  python3 driver.py interrupt <prompt_id>
  python3 driver.py upload <local_image> <remote_name>
"""
import json
import sys
import time
import urllib.request
import urllib.parse
import uuid
import os

BASE = "http://192.168.123.147:8188"
CLIENT_ID = "h3-continuation-poc"


def http(method, path, data=None, raw=False, timeout=30):
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None and not raw:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return body if raw else json.loads(body)


def queue_state():
    d = http("GET", "/queue")
    return len(d["queue_running"]), len(d["queue_pending"])


def wait_idle(poll=20):
    while True:
        run, pend = queue_state()
        if run == 0 and pend == 0:
            print("queue idle")
            return
        print(f"busy running={run} pending={pend}, wait {poll}s", flush=True)
        time.sleep(poll)


def build_wf(prompt, seed, output_prefix, first_frame=None,
             width=480, height=832, length=73, steps=6):
    wf = {
        "2": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            "weight_dtype": "default"}},
        "3": {"class_type": "ReservedVRAMSetter", "inputs": {
            "anything": ["2", 0], "reserved": 1, "mode": "manual",
            "seed": 12345, "auto_max_reserved": 0, "clean_gpu_before": True}},
        "4": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["5", 0],
            "lora_name": "minimax_h3_turbo_v4_step600_ema.safetensors",
            "strength_model": 1.0}},
        "5": {"class_type": "UniBlockSwap", "inputs": {
            "model": ["19", 0], "num_blocks": -1}},
        "6": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "type": "minimax", "device": "default"}},
        "7": {"class_type": "VAELoader", "inputs": {
            "vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "8": {"class_type": "VAELoader", "inputs": {
            "vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "10": {"class_type": "MiniMaxH3AudioConditioningT8", "inputs": {
            "clip": ["6", 0], "video_vae": ["7", 0], "audio_vae": ["8", 0],
            "prompt": prompt, "width": width, "height": height, "length": length,
            "task_type": "I2VA" if first_frame else "T2VA",
            "audio_mode": "native", "audio_denoise_strength": 0.65,
            "add_source_as_reference": False, "prompt_primary_audio_ordinal": 0,
            "strict_prompt_tags": True, "ref_image_size": "max",
            "reference_video_policy": "official_2_to_15s"}},
        "11": {"class_type": "MiniMaxH3DualClockSamplerT8", "inputs": {
            "model": ["4", 0], "av_latent": ["10", 1], "steps": steps,
            "shift_video": 12.0, "shift_audio": 3.0}},
        "12": {"class_type": "BasicGuider", "inputs": {
            "model": ["11", 0], "conditioning": ["10", 0]}},
        "13": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "14": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["13", 0], "guider": ["12", 0], "sampler": ["11", 1],
            "sigmas": ["11", 2], "latent_image": ["10", 1]}},
        "15": {"class_type": "MiniMaxH3AVDecodeT8", "inputs": {
            "av_latent": ["14", 0], "video_vae": ["7", 0], "audio_vae": ["8", 0]}},
        "16": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["15", 0], "audio": ["15", 1], "frame_rate": 24,
            "loop_count": 0, "filename_prefix": output_prefix,
            "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": 19,
            "save_metadata": True, "trim_to_audio": False, "pingpong": False,
            "save_output": True}},
        "19": {"class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch", "inputs": {
            "model": ["3", 0]}},
    }
    if first_frame:
        wf["9"] = {"class_type": "LoadImage", "inputs": {"image": first_frame}}
        wf["10"]["inputs"]["first_frame"] = ["9", 0]
    return wf


def submit(meta_path):
    meta = json.load(open(meta_path))
    wf = build_wf(
        prompt=meta["prompt"], seed=meta["seed"],
        output_prefix=meta["output_prefix"],
        first_frame=meta.get("first_frame"),
        width=meta.get("width", 480), height=meta.get("height", 832),
        length=meta.get("length", 73), steps=meta.get("steps", 6))
    leftover = [t for t in __import__("re").findall(r"\{\{\w+\}\}", json.dumps(wf))]
    assert not leftover, f"unrendered tokens: {leftover}"
    payload = json.dumps({"prompt": wf, "client_id": CLIENT_ID}).encode()
    d = http("POST", "/prompt", data=payload)
    print(json.dumps(d))
    meta["prompt_id"] = d["prompt_id"]
    meta["submitted_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    json.dump(meta, open(meta_path, "w"), indent=2, ensure_ascii=False)


def status(prompt_id):
    d = http("GET", f"/history/{prompt_id}")
    if prompt_id not in d:
        run, pend = queue_state()
        print(json.dumps({"state": "not_in_history", "queue_running": run, "queue_pending": pend}))
        return
    h = d[prompt_id]
    st = h.get("status", {})
    print(json.dumps({
        "state": "done" if st.get("completed") else st.get("status_str", "unknown"),
        "status": st,
        "outputs": {k: {kk: vv for kk, vv in v.items() if kk in ("videos", "gifs", "images")}
                    for k, v in h.get("outputs", {}).items()},
    }, ensure_ascii=False)[:3000])


def download(prompt_id, out):
    d = http("GET", f"/history/{prompt_id}")
    h = d[prompt_id]
    for node_out in h.get("outputs", {}).values():
        for key in ("videos", "gifs"):
            for f in node_out.get(key, []):
                q = urllib.parse.urlencode({
                    "filename": f["filename"], "subfolder": f.get("subfolder", ""),
                    "type": f.get("type", "output")})
                data = http("GET", f"/view?{q}", raw=True, timeout=300)
                open(out, "wb").write(data)
                print(f"saved {out} ({len(data)} bytes) from {f['filename']}")
                return
    print("no video output found", file=sys.stderr)
    sys.exit(1)


def interrupt(prompt_id):
    try:
        http("POST", "/interrupt", data=b"{}")
        print("interrupt sent")
    except Exception as e:
        print(f"interrupt error: {e}")
    try:
        http("POST", "/queue", data=json.dumps({"delete": [prompt_id]}).encode())
        print("queue delete sent")
    except Exception as e:
        print(f"queue delete error: {e}")


def upload(local, remote_name):
    boundary = uuid.uuid4().hex
    with open(local, "rb") as f:
        img = f.read()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
        f"filename=\"{remote_name}\"\r\nContent-Type: image/png\r\n\r\n"
    ).encode() + img + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/upload/image", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(req, timeout=120) as r:
        print(r.read().decode())


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "wait-idle":
        wait_idle()
    elif cmd == "submit":
        submit(sys.argv[2])
    elif cmd == "status":
        status(sys.argv[2])
    elif cmd == "download":
        download(sys.argv[2], sys.argv[3])
    elif cmd == "interrupt":
        interrupt(sys.argv[2])
    elif cmd == "upload":
        upload(sys.argv[2], sys.argv[3])
    elif cmd == "free":
        http("POST", "/free", data=json.dumps({"unload_models": True, "free_memory": True}).encode(), raw=True)
        print("freed")
