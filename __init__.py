"""
ComfyUI 镜像补缺（comfyui-mirror-fetch）

缺模型时，一键从可配置的镜像端点补齐，带断点续传。
不改官方任何文件，升级不碎。

后端：注册三个接口
    GET  /mirror_fetch/info            版本与配置
    POST /mirror_fetch/check           给一批 {name, directory}，返回哪些已存在
    POST /mirror_fetch/download        给 {url, name, directory}，开始下载
    GET  /mirror_fetch/jobs            下载进度

镜像端点优先级：
    环境变量 HF_MIRROR  >  本文件 MIRROR 默认值
"""

import os
import time
import json
import threading
import urllib.request
import urllib.error

try:
    from server import PromptServer
    from aiohttp import web
    import folder_paths
except Exception as e:  # 不在 ComfyUI 里时应静默失败，不拖垮启动
    print(f"[mirror-fetch] 无法加载 ComfyUI 依赖: {e}")
    PromptServer = None

VERSION = "0.1.0"
MIRROR = os.environ.get("HF_MIRROR", "https://hf-mirror.com")
UA = {"User-Agent": "comfyui-mirror-fetch/" + VERSION}

WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

JOBS = {}
JOBS_LOCK = threading.Lock()

# 并发上限：同时最多下 5 个，其余排队（跟浏览器下载器的做法一致）
MAX_CONCURRENT = int(os.environ.get("MIRROR_FETCH_CONCURRENCY", "5"))
DL_SLOTS = threading.Semaphore(MAX_CONCURRENT)


# ------------------------------------------------------------------ 工具

def models_root():
    """ComfyUI 的 models 根目录"""
    try:
        return os.path.dirname(folder_paths.folder_names_and_paths["checkpoints"][0][0])
    except Exception:
        return os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")


_DIR_ALIAS = {
    "unet": "diffusion_models",
    "transformer": "diffusion_models",
    "clip": "text_encoders",
    "text_encoder": "text_encoders",
    "lora": "loras",
    "checkpoint": "checkpoints",
    "vae_approx": "vae_approx",
}


def target_dir(directory):
    """始终落到 models/<标准目录名>。

    不用 folder_paths 的映射——它把 diffusion_models 映射成 unet、
    text_encoders 映射成 clip，跟用户库里实际的目录不一致，
    会导致同一个文件在两个目录各下一份。
    """
    d = (directory or "diffusion_models").strip().strip("/\\")
    d = _DIR_ALIAS.get(d, d)
    p = os.path.join(models_root(), d)
    os.makedirs(p, exist_ok=True)
    return p


def find_existing(name, directory):
    """返回 (状态, 本地字节, 路径)。状态：complete / partial / missing"""
    name = (name or "").replace("\\", "/")
    base = os.path.basename(name)
    d = target_dir(directory)
    dest = os.path.join(d, base)
    tmp = dest + ".part"

    if os.path.exists(dest):
        try:
            return "complete", os.path.getsize(dest), dest
        except OSError:
            pass
    if os.path.exists(tmp):
        try:
            return "partial", os.path.getsize(tmp), tmp
        except OSError:
            pass
    return "missing", 0, dest


def to_mirror(url):
    """把 HF 原始地址换成本地镜像"""
    if not isinstance(url, str):
        return None
    for host in ("https://huggingface.co/", "https://hf.co/"):
        if url.startswith(host):
            return MIRROR + "/" + url[len(host):]
    if url.startswith(MIRROR + "/"):
        return url
    return None


# ------------------------------------------------------------------ 下载线程

def run_download(job_id, url, name, directory):
    job = JOBS[job_id]

    # 排队等一个并发名额；等到之前若被取消/暂停，直接退出
    DL_SLOTS.acquire()
    try:
        with JOBS_LOCK:
            if job.get("stop") or job.get("cancel"):
                job.update(state="cancelled" if job.get("cancel") else "paused", speed=0)
                return
            job["state"] = "downloading"
        _do_download(job, job_id, url, name, directory)
    finally:
        DL_SLOTS.release()


def _do_download(job, job_id, url, name, directory):
    d = target_dir(directory)
    dest = os.path.join(d, os.path.basename(name.replace("\\", "/")))
    tmp = dest + ".part"
    os.makedirs(d, exist_ok=True)

    start_from = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    headers = dict(UA)
    if start_from:
        headers["Range"] = f"bytes={start_from}-"

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            # 服务端必须回 206 才是真正的续传。
            # 如果它忽略 Range 直接给 200 全量，追加写入会变成"半截 + 全文"的坏文件。
            if start_from and r.status != 206:
                start_from = 0
                headers.pop("Range", None)
                with JOBS_LOCK:
                    job["resumed"] = False
            total = int(r.headers.get("Content-Length") or 0) + start_from
            with JOBS_LOCK:
                job.update(state="downloading", total=total, done=start_from,
                           resumed=start_from > 0)
            mode = "ab" if start_from else "wb"
            done, base, t0 = start_from, start_from, time.time()
            with open(tmp, mode) as f:
                while True:
                    if job.get("stop"):
                        raise IOError("已取消")
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    el = max(time.time() - t0, 0.001)
                    rate = (done - base) / el
                    with JOBS_LOCK:
                        job["done"] = done
                        job["speed"] = rate
                        job["eta"] = (total - done) / rate if rate > 0 and total else 0
        # 关键：必须确认下载完整，否则半截文件会被当成成品
        if total and done != total:
            raise IOError(f"下载不完整: {done}/{total} 字节，已保留 .part 供续传")
        os.replace(tmp, dest)
        with JOBS_LOCK:
            job.update(state="done", path=dest, speed=0, eta=0)
    except Exception as e:
        if job.get("pause"):
            with JOBS_LOCK:
                job.update(state="paused", speed=0, eta=0)
        elif job.get("cancel"):
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except Exception:
                pass
            with JOBS_LOCK:
                job.update(state="cancelled", speed=0, eta=0)
        else:
            with JOBS_LOCK:
                job.update(state="error", error=f"{type(e).__name__}: {e}", speed=0)


# ------------------------------------------------------------------ 路由

def mirror_get_json(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _fix_dir(path, directory):
    """把仓库里的路径段映射成 ComfyUI 的子目录名"""
    seg = (path or "").split("/")[0] if "/" in (path or "") else ""
    d = directory or seg or "diffusion_models"
    if seg in ("text_encoder", "text_encoders"):
        d = "text_encoders"
    elif seg == "transformer":
        d = "diffusion_models"
    elif seg == "lora":
        d = "loras"
    elif seg and seg not in ("split_files",):
        d = seg
    return d


_CACHE = {}


def _search_ids(kw):
    import urllib.parse as _up
    try:
        d = mirror_get_json(f"{MIRROR}/api/models?search={_up.quote(kw)}&limit=40&full=false")
    except Exception:
        return []
    if not isinstance(d, list):
        return []
    return [c.get("id") or c.get("modelId") for c in d if (c.get("id") or c.get("modelId"))]


def _repo_hit(repo, stem):
    try:
        d = mirror_get_json(f"{MIRROR}/api/models/{repo}?blobs=true")
    except Exception:
        return None
    for s in d.get("siblings", []):
        p = s.get("rfilename", "")
        if os.path.basename(p) == stem:
            return {
                "repo": repo,
                "path": p,
                "url": f"{MIRROR}/{repo}/resolve/main/{p}",
                "size": int(s.get("size") or 0),
            }
    return None


def resolve_by_filename(name, prefer_orgs=("Comfy-Org",)):
    """按文件名去镜像上找仓库。

    不依赖 ComfyUI 内部结构 —— 只要文件在 HuggingFace 上，就有机会找到。
    为速度做了两处并行：关键词搜索并行、仓库探测并行。
    返回 {repo, path, url, size} 或 None。
    """
    from concurrent.futures import ThreadPoolExecutor

    stem = os.path.basename((name or "").replace("\\", "/"))
    if not stem:
        return None
    base = stem.rsplit(".", 1)[0]

    # 搜索词：完整名 + 所有相邻词对 + 较长的单词。
    # 只取前缀不够：qwen3vl_32b_minimax_h3_nvfp4_awq 真正能搜到仓库的词是
    # 中间的 minimax_h3，不是开头的 qwen3vl。
    parts = [p for p in base.replace("-", "_").split("_") if p]
    kws = [base]
    for i in range(len(parts) - 1):
        kws.append(parts[i] + "_" + parts[i + 1])
    kws += [p for p in parts if len(p) >= 4]
    seen_kw, dedup = set(), []
    for k in kws:
        k = k.strip().lower()
        if len(k) >= 3 and k not in seen_kw:
            seen_kw.add(k)
            dedup.append(k)
    kws = dedup[:8]

    # ① 关键词并行搜索
    ids = []
    with ThreadPoolExecutor(max_workers=min(8, len(kws))) as ex:
        for res in ex.map(_search_ids, kws):
            for i in res:
                if i not in ids:
                    ids.append(i)

    if not ids:
        return None

    # ② 排序：官方仓库优先；其次仓库名与文件名共有的"词"越多越靠前
    toks = {p.lower() for p in parts if len(p) >= 3}

    def score(repo):
        low = repo.lower()
        overlap = sum(1 for t in toks if t in low)
        return (0 if any(repo.startswith(o + "/") for o in prefer_orgs) else 1,
                -overlap, len(repo))

    ids.sort(key=score)

    # ③ 仓库探测并行（每批 5 个，命中即停）
    for start in range(0, min(len(ids), 20), 5):
        batch = ids[start:start + 5]
        with ThreadPoolExecutor(max_workers=len(batch)) as ex:
            for hit in ex.map(lambda r: _repo_hit(r, stem), batch):
                if hit:
                    return hit
    return None

class _NoRoutes:
    """PromptServer 没就绪时的空壳：装饰器照常可用，只是不注册任何路由。
    这样整个模块永远不会因为加载顺序而炸。"""

    def _deco(self, *a, **k):
        def wrap(fn):
            return fn
        return wrap

    def get(self, *a, **k):
        return self._deco()

    def post(self, *a, **k):
        return self._deco()


if PromptServer is not None:
    try:
        routes = PromptServer.instance.routes
    except Exception as _e:
        routes = _NoRoutes()
        print(f"[mirror-fetch] PromptServer.instance 尚未就绪: {_e}")
else:
    routes = _NoRoutes()

if True:

    @routes.get("/mirror_fetch/info")
    async def mf_info(request):
        return web.json_response({
            "version": VERSION,
            "mirror": MIRROR,
            "models_root": models_root(),
            "max_concurrent": MAX_CONCURRENT,
        })

    @routes.post("/mirror_fetch/check")
    async def mf_check(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        items = body.get("items") or []
        out = []
        for it in items:
            st, have, path = find_existing(it.get("name"), it.get("directory"))
            out.append({"name": it.get("name"), "directory": it.get("directory"),
                        "state": st, "have": have, "path": path})
        return web.json_response({"items": out})

    @routes.post("/mirror_fetch/resolve")
    async def mf_resolve(request):
        import asyncio

        try:
            body = await request.json()
        except Exception:
            body = {}
        names = [n for n in (body.get("names") or []) if n]

        loop = asyncio.get_event_loop()

        def work(n):
            cached = _CACHE.get(n)
            if cached is not None:
                return n, cached
            r = resolve_by_filename(n)
            if r:
                r["directory"] = _fix_dir(r.get("path", ""), r.get("directory"))
            _CACHE[n] = r
            return n, r

        # 并行 + 缓存：第一次约几秒，之后瞬时
        results = await asyncio.gather(*[loop.run_in_executor(None, work, n) for n in names])
        found = {n: r for n, r in results if r}
        return web.json_response({"found": found, "cached": len(found) - 0})

    @routes.post("/mirror_fetch/pause")
    async def mf_pause(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        n = 0
        with JOBS_LOCK:
            for j in JOBS.values():
                hit = body.get("all") or j["job"] == body.get("job") or \
                      (body.get("name") and os.path.basename(j.get("name", "")) == body["name"])
                if hit and j["state"] in ("queued", "downloading"):
                    j["pause"] = True
                    j["stop"] = True
                    n += 1
        return web.json_response({"paused": n})

    @routes.post("/mirror_fetch/cancel")
    async def mf_cancel(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        n = 0
        with JOBS_LOCK:
            for j in JOBS.values():
                hit = body.get("all") or j["job"] == body.get("job") or \
                      (body.get("name") and os.path.basename(j.get("name", "")) == body["name"])
                if hit and j["state"] in ("queued", "downloading", "paused"):
                    j["cancel"] = True
                    j["stop"] = True
                    if j["state"] == "paused":  # 已经停了，直接清理
                        j["state"] = "cancelled"
                    n += 1
        return web.json_response({"cancelled": n})

    @routes.post("/mirror_fetch/download")
    async def mf_download(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad json"}, status=400)
        raw = body.get("url")
        name = body.get("name") or ""
        directory = body.get("directory") or "diffusion_models"
        url = to_mirror(raw)
        if not url:
            return web.json_response({"error": f"不支持或不需要改写: {str(raw)[:80]}"}, status=400)

        st, have, path = find_existing(name, directory)
        jid = f"{int(time.time()*1000)}_{len(JOBS)}"

        # 同一个文件已经在下 → 直接返回原任务，不重复下
        base = os.path.basename((name or "").replace("\\", "/"))
        with JOBS_LOCK:
            for j in JOBS.values():
                if (os.path.basename(j.get("name", "")) == base
                        and j.get("state") in ("queued", "downloading")):
                    return web.json_response({"job": j["job"], "already": True})
            # 清掉这个文件的历史任务（暂停/失败/已完成的），避免列表越滚越长
            for k in [k for k, j in JOBS.items()
                      if os.path.basename(j.get("name", "")) == base
                      and j.get("state") not in ("queued", "downloading")]:
                JOBS.pop(k, None)

        with JOBS_LOCK:
            JOBS[jid] = {"job": jid, "name": name, "directory": directory,
                         "url": url, "state": "queued", "done": 0, "total": 0,
                         "speed": 0, "eta": 0}
            # 只保留最近 50 条，避免长时间使用后内存和界面无限增长
            if len(JOBS) > 50:
                for k in sorted(JOBS.keys())[:-50]:
                    if JOBS[k].get("state") not in ("queued", "downloading"):
                        JOBS.pop(k, None)
        if st == "complete":
            with JOBS_LOCK:
                JOBS[jid].update(state="done", done=have, total=have,
                                 path=path, speed=0, eta=0, skipped=True)
            return web.json_response({"job": jid, "skipped": True})

        threading.Thread(target=run_download, args=(jid, url, name, directory),
                         daemon=True).start()
        return web.json_response({"job": jid})

    @routes.get("/mirror_fetch/jobs")
    async def mf_jobs(request):
        with JOBS_LOCK:
            return web.json_response(dict(JOBS))

    print(f"[mirror-fetch] v{VERSION} 已加载，镜像端点 {MIRROR}")
