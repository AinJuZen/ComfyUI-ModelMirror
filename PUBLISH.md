# 发布步骤（照着敲，5 分钟）

发布包已经准备好：

```
E:\WorkSpace\_shared\assets\comfyui-mirror-fetch\
```

## 0. 先把 LICENSE 里的占位符改掉

```powershell
notepad E:\WorkSpace\_shared\assets\comfyui-mirror-fetch\LICENSE
```

把 `<YOUR NAME>` 换成你的名字或 ID。

## 1. 建仓库

名字建议：`comfyui-mirror-fetch`（跟目录名一致，ComfyUI 用户一眼看懂）

在 GitHub 上新建一个 **空** 仓库（不要勾 README / .gitignore / LICENSE，我们本地已有）。

## 2. 本地初始化并推送

```powershell
cd E:\WorkSpace\_shared\assets\comfyui-mirror-fetch

git init
git add .
git commit -m "feat: 缺模型一键镜像补齐（暂停/续传/并发/完整性校验）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/comfyui-mirror-fetch.git
git push -u origin main
```

## 3. 打一个 tag

```powershell
git tag -a v0.1.0 -m "v0.1.0 首个可用版本"
git push origin v0.1.0
```

## 4. 发 Release

GitHub 页面 → Releases → Draft a new release → 选 `v0.1.0` → 发布。

**资产不用传**，用户 `git clone` 即可。

## 5. 发到社区（可选，但决定有没有人用）

**推荐三个地方：**

```
① ComfyUI 中文社区 / QQ 群 / 微信群
   一句话：「缺模型下不动？这个扩展按文件名自动找官方仓库，走镜像下，支持暂停续传」

② V2EX / 少数派（如果想让非 ComfyUI 用户也看到）

③ Reddit r/comfyui（英文 README 段落已经写好）
```

**发的时候只放一张截图 + 一句话，别写长篇。**

## 6. 发布后前三天要做的事

```
· 盯 issue，前三个 bug 决定项目生死
· 有人报"按钮不出现"→ 先问 ComfyUI 版本和界面语言
  （注入点做了多语言匹配，但新版本可能又改）
· 有人报"下完看不见"→ 一定是目录判定问题，让他点「复制诊断」发你
```

---

## 需要注意的三件事

**① README 里那个截图是本地测试时截的**

`docs/screenshot.png` 可以用，但如果你想要更好看的，重新截一张面板展开的。

**② 版本号在 `__init__.py` 里**

```python
VERSION = "0.1.0"
```

改代码后记得同步改这里，并在 README 的兼容性表里加一行。

**③ 这个项目最大的卖点只有一句**

> **不改官方文件，升级不碎。**

**所有宣传都围绕这句。别的都是细节。**

---

## 出问题时的退路

发布后如果被指出方向性错误（比如"官方下个版本自己做了"），
**不要硬撑**。在 README 顶部写一句：

> 官方已在 X 版本支持镜像，本项目转为兼容旧版本。

**这比装作无事发生体面得多，也更容易再获得信任。**
