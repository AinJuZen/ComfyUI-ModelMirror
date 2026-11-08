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

VERSION = "0.2.8"
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


# 只允许写进这些标准模型目录。名字来自 ComfyUI 自己的约定。
# 不在这张表里的 directory 一律拒绝——这是防目录穿越的第一道闸。
MODEL_DIRS = (
    "checkpoints", "diffusion_models", "text_encoders", "vae", "loras",
    "controlnet", "clip_vision", "upscale_models", "embeddings",
    "audio_encoders", "vae_approx", "gligen", "photomaker", "style_models",
    "hypernetworks", "t2i_adapter", "configs", "model_patches", "diffusers",
)


class BadDir(ValueError):
    """directory 不合法。路由层要把它翻成 400，而不是 500。"""


def safe_dir_name(directory):
    """把请求里的 directory 收敛成一个合法的模型目录名。

    拒绝：空、绝对路径、盘符、``..``、任何分隔符、控制字符。
    不在白名单里的名字也拒绝——宁可报错，也不替用户新建目录。
    """
    d = (directory or "").strip()
    if not d:
        return "diffusion_models"

    # 反斜杠统一成正斜杠后再判断，避免 Windows 分隔符绕过
    norm = d.replace("\\", "/")

    if norm.startswith("/") or norm.startswith("~"):
        raise BadDir("absolute path not allowed")
    if len(norm) >= 2 and norm[1] == ":":
        raise BadDir("drive letter not allowed")
    if "/" in norm:
        raise BadDir("path separators not allowed")

    d = _DIR_ALIAS.get(norm, norm)
    if d not in MODEL_DIRS:
        raise BadDir("unknown model folder: " + d)
    return d


def target_dir(directory, create=False):
    """返回 models/<标准目录名> 的绝对路径。

    两道闸：
      ① safe_dir_name 只放行白名单目录名，挡住 ``..``、盘符、分隔符；
      ② 拼完之后再用 realpath + commonpath 确认没跑出 models 根目录。
    只有 create=True 时才建目录——读路径不该产生副作用。
    """
    d = safe_dir_name(directory)
    root = os.path.realpath(models_root())
    p = os.path.realpath(os.path.join(root, d))

    if p != root and not p.startswith(root + os.sep):
        raise BadDir("resolved path escapes models root")

    if create:
        os.makedirs(p, exist_ok=True)
    return p


def safe_file_name(name):
    """文件名只取 basename，并拒绝空名和点号名。"""
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    if not base or base in (".", ".."):
        raise BadDir("bad file name")
    return base


def assert_inside_models(path):
    """确认 path 解析后仍在 models 根目录下。

    防的是 .part 被做成符号链接：下载时用 "ab"/"wb" 打开，会顺着链接
    写到 models 之外去（截断或追加别人的文件）。
    os.link 的安全边界必须在这里再查一次，而不是只查目录名。
    """
    root = os.path.realpath(models_root())
    real = os.path.realpath(path)
    if real == root or real.startswith(root + os.sep):
        return
    raise BadDir("refusing to write outside models/: " + os.path.basename(path))


def find_existing(name, directory):
    """返回 (状态, 本地字节, 路径)。状态：complete / partial / missing"""
    name = (name or "").replace("\\", "/")
    base = safe_file_name(name)
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

def friendly_error(e):
    """把底层异常翻成人话。

    原始文案（URLError: <urlopen error [SSL: UNEXPECTED_EOF...>）对用户没有意义，
    而且会让人以为插件坏了——实际多半是网络中途断了。
    """
    name = type(e).__name__
    msg = str(e)
    low = msg.lower()

    if ("unexpected_eof" in low or "eof occurred" in low or "connection reset" in low
            or "reset by peer" in low or "forcibly closed" in low or "10054" in low
            or "10053" in low or "aborted" in low):
        return "连接被中途断开（网络不稳），已下载的部分保留着，点「重试」接着下"
    if "timed out" in low or "timeout" in low:
        return "连接超时。可以点「重试」，或先下载别的文件"
    if "ssl" in low or "certificate" in low:
        return "TLS 握手失败（网络被干扰或代理没开），换个时间重试"
    if "403" in low or "forbidden" in low:
        return "镜像拒绝了这个文件（可能需要登录或已下架）"
    if "404" in low or "not found" in low:
        return "镜像上没有这个文件（文件名可能被改过）"
    if "no space" in low or "errno 28" in low:
        return "磁盘空间不够"
    if "permission" in low or "access is denied" in low:
        return "没有写入权限，检查 models 目录的权限"
    if "下载不完整" in msg:
        return msg          # 这条本来就是我们自己写的中文
    if "已取消" in msg:
        return msg
    # 兜底：保留类型名和短消息，别甩整段堆栈
    return f"{name}: {msg[:120]}"


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
    d = target_dir(directory, create=True)
    dest = os.path.join(d, safe_file_name(name))
    tmp = dest + ".part"
    # 目录已在 target_dir(create=True) 里建好，这里不再 makedirs

    # dest 与 .part 都不能指向 models 之外（.part 可能是别人做的符号链接）
    assert_inside_models(dest)
    assert_inside_models(tmp)

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
                job.update(state="error", error=friendly_error(e), speed=0)


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


# ------------------------------------------------------------------ 解析缓存
# 内存缓存只在进程活着时有效——重启一次就全丢，用户每次都吃 10-40 秒。
# 落一份到 models 旁边，7 天有效；命中的话解析瞬间返回。
_CACHE_TTL = 7 * 24 * 3600
_disk_cache = None
_disk_lock = threading.Lock()


def _cache_path():
    r"""缓存放在 ComfyUI 的 user\ 下，不依赖 models 根是否存在。

    之前用 models_root() 兜底分支会落到 custom_nodes\models\，
    在没有 folder_paths 的环境里就会在插件目录里造一个假的 models 目录。
    """
    # __file__ 是 custom_nodes/<插件>/__init__.py，往上三级才是 ComfyUI 根
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for sub in ("user", ""):
        try:
            d = os.path.join(root, sub) if sub else root
            os.makedirs(d, exist_ok=True)
            probe = os.path.join(d, ".mirror_fetch_cache_probe")
            with open(probe, "w") as f:
                f.write("1")
            os.remove(probe)
            return os.path.join(d, "mirror_fetch_resolve_cache.json")
        except Exception:
            continue
    return ""


def _load_disk_cache():
    global _disk_cache
    if _disk_cache is not None:
        return _disk_cache
    _disk_cache = {}
    p = _cache_path()
    if not p or not os.path.exists(p):
        return _disk_cache
    try:
        with open(p, "r", encoding="utf-8") as f:
            raw = json.load(f)
        now = time.time()
        for k, v in raw.items():
            if isinstance(v, dict) and now - float(v.get("_ts") or 0) < _CACHE_TTL:
                _disk_cache[k] = v
    except Exception:
        _disk_cache = {}
    return _disk_cache


def _save_disk_cache():
    p = _cache_path()
    if not p:
        return
    try:
        with _disk_lock:
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(_disk_cache or {}, f, ensure_ascii=False)
            os.replace(tmp, p)
    except Exception:
        pass


_SEARCH_MEMO = {}


def _search_ids(kw):
    import urllib.parse as _up
    if kw in _SEARCH_MEMO:
        return _SEARCH_MEMO[kw]
    try:
        d = mirror_get_json(f"{MIRROR}/api/models?search={_up.quote(kw)}&limit=40&full=false")
    except Exception:
        return []
    if not isinstance(d, list):
        _SEARCH_MEMO[kw] = []
        return []
    ids = [c.get("id") or c.get("modelId") for c in d if (c.get("id") or c.get("modelId"))]
    _SEARCH_MEMO[kw] = ids
    return ids


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
        root = os.path.realpath(models_root())
        for it in items:
            try:
                st, have, path = find_existing(it.get("name"), it.get("directory"))
            except BadDir as e:
                return web.json_response({"error": str(e)}, status=400)
            # 只回相对路径：客户端不需要知道这台机器的绝对路径
            rel = os.path.relpath(path, root).replace("\\", "/")
            out.append({"name": it.get("name"), "directory": safe_dir_name(it.get("directory")),
                        "state": st, "have": have, "path": rel})
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
            if cached is None:
                dc = _load_disk_cache().get(n)
                if dc and dc.get("url"):
                    _CACHE[n] = {k: v for k, v in dc.items() if k != "_ts"}
                    cached = _CACHE[n]
            if cached is not None:
                return n, cached
            r = resolve_by_filename(n)
            if r:
                r["directory"] = _fix_dir(r.get("path", ""), r.get("directory"))
            _CACHE[n] = r
            try:
                r2 = dict(r)
                r2["_ts"] = time.time()
                _load_disk_cache()[n] = r2
            except Exception:
                pass
            return n, r

        # 并行 + 缓存：第一次约几秒，之后瞬时
        results = await asyncio.gather(*[loop.run_in_executor(None, work, n) for n in names])
        found = {n: r for n, r in results if r}
        _save_disk_cache()
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

        try:
            directory = safe_dir_name(directory)
            safe_file_name(name)
            st, have, path = find_existing(name, directory)
        except BadDir as e:
            return web.json_response({"error": str(e)}, status=400)
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
