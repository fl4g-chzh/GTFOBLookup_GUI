# GTFOBLookup GUI

离线版 GTFOBins / LOLBAS / WADComs / HijackLibs 检索工具，基于 Electron + React + TypeScript。

## 功能

- 本地离线搜索四个提权/绕过相关数据源
- 按数据源筛选并查看详情、示例、链接
- 本地 SQLite 数据库存储
- 支持同步代理设置
- 支持 Windows 安装包打包

## 技术栈

- Electron
- React 19
- TypeScript
- Vite
- sql.js

## 本地开发

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

类型检查：

```bash
npm run typecheck
```

Lint：

```bash
npm run lint
```

## 数据同步

命令行同步四个数据源：

```bash
npm run sync
```

## 构建与打包

构建前端和 Electron 产物：

```bash
npm run build
```

打 Windows 安装包：

```bash
npm run pack:win
```

一条命令完成构建和打包：

```bash
npm run dist:win
```

产物目录：

- 前端构建：`app-dist`
- Electron 构建：`dist-electron`
- 安装包输出：`release`

## GitHub Actions

仓库已配置 Windows 自动构建与发布工作流：

- 推送到 `main` 时自动构建并上传 Artifact
- 手动触发时也可直接构建
- 推送 `v*` 标签时自动创建 GitHub Release 并上传安装包

发布新版本示例：

```bash
git add .
git commit -m "release: v0.1.0"
git push
git tag v0.1.0
git push origin v0.1.0
```

## 注意事项

- 打包前请先关闭旧的 `GTFOBLookup` 运行实例，避免 `win-unpacked` 被锁定
- 当前未配置自定义 `.ico` 图标，安装包会使用默认 Electron 图标
- 首次同步依赖网络，建议在设置中配置代理
