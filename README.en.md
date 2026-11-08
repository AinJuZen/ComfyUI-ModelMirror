# ComfyUI-ModelMirror

**Fills in missing models from a mirror you can actually reach.**

Open a workflow someone shared and ComfyUI shows _missing models_. Its download button
connects straight to `huggingface.co`, which is unreachable on some networks — and the
desktop build has no mirror option at all (I counted: `hf-mirror` appears 0 times in
`app.asar`; the existing "use Chinese mirrors" switch only covers Git and PyPI).

This extension adds a **Mirror Fetch** button in the same panel. It finds what is missing,
resolves each filename to its official HuggingFace repo through a configurable mirror, and
downloads it into the correct `models/<type>/` folder with resume support.

**It patches nothing.** Upgrade ComfyUI freely.

---

## Install

```bash
comfy node install comfyui-modelmirror
```

Or download the ZIP and drop the folder into `custom_nodes/` (rename `-main` away), then
restart ComfyUI. No `pip install`, no dependencies.

Requires ComfyUI ≥ 0.3.x, including Desktop.

---

## Usage

1. Open a workflow with missing models
2. In the Missing Models panel, click **Mirror Fetch**
3. Each row offers Download / Pause / Resume / Cancel / Retry, with live progress

---

## How it works

```
scan the workflow for referenced model files
        ↓
look each filename up on the mirror (full stem first, then token pairs)
        ↓
prefer Comfy-Org/* repos, match on basename
        ↓
download into models/<folder>, resumable, integrity-checked
```

**The folder comes from the node's widget name** (`ckpt_name` → `checkpoints`,
`unet_name` → `diffusion_models`, …), not from guessing by filename — otherwise the file
downloads fine but the node still cannot see it.

**Why not read the URL out of the workflow?** Different ComfyUI versions put
`properties.models` in different places (graph / object_info / workflowManager); three
attempts were all fragile. Resolving by filename only depends on the file's name, which
ComfyUI is not going to change.

---

## Safety

The tool writes files, so this matters:

- `directory` is validated against an allowlist of standard model folders. Absolute paths,
  drive letters, `~`, path separators and `..` are rejected with HTTP 400 — nothing is created.
- After joining, `realpath` + `commonpath` re-check that the target is still under `models/`.
- `dest` and `dest.part` are checked the same way before opening, so a `.part` symlink
  pointing outside `models/` is refused instead of appended to.
- `/mirror_fetch/check` returns relative paths only — no host paths leak to the client.
- Files are never overwritten: same name + same size is skipped, same name + different size
  is saved as `name_1.safetensors`.

**v0.2.0 fixed a path traversal issue** found during the ComfyUI-Manager listing review
([PR #3477](https://github.com/Comfy-Org/ComfyUI-Manager/pull/3477)). If you run 0.1.x,
please upgrade.

---

## Language

**English is the source language** for the UI, code comments and backend messages.
When `navigator.language` starts with `zh`, a Chinese translation is applied at build time.

One exception: the label list used to locate the official "Download all" button, and the
regex that finds the missing-models container, stay bilingual on purpose. Those are **match
patterns** against ComfyUI's own UI, not display text.

---

## Known limitations

- **It is a heuristic, not a lookup table.** Private or gated repos, and files that were
  renamed after the workflow was published, will not be found. When it cannot find one, it
  says so and leaves the file alone.
- Mirror speed depends on a third party: measured 0.2 – 55 MB/s depending on time of day.
- Models hosted on civitai have no mirror and are out of scope.
- Editing a `.py` requires restarting ComfyUI; editing a `.js` only needs a page reload.

---

## What it is built against

| | |
|---|---|
| ComfyUI | 0.44.2 |
| comfyui-frontend-package | 1.57.6 |
| Python | 3.13.12 |
| OS | Windows 11 |

## License

MIT. See [LICENSE](LICENSE).

## Author

[@AinJuZen](https://github.com/AinJuZen) · [Bilibili](https://space.bilibili.com/322892)

Chinese README (primary): [README.md](README.md)
