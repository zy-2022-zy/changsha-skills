# 长沙移动系统集团驳回数据Skill 安装包

构建命令：

```powershell
pnpm install --frozen-lockfile
pnpm run build:installer
pnpm run test:installer
```

构建脚本从 Windows 的卸载注册表或 PATH 查找已安装的 Inno Setup Compiler。也可显式指定：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1 -IsccPath 'D:\sort\innosetup\ISCC.exe'
```

输出为 `dist/长沙移动系统集团驳回数据Skill.exe` 和同名 `.exe.sha256` 校验文件。文件名、安装界面和卸载列表的名称统一取自 `package.json` 的 `productName`；版本保存在 EXE 属性中。需要 Windows x64、Node.js 20+ 及 Inno Setup 6.3+；安装包内置构建机器的 Node.js 运行时与许可证、编译后的程序、生产依赖、TypeScript 源码、技能说明和启动器。只用显式清单复制文件，不包含 `.env`、`.runtime`、`reports`、下载文件或文档解压缓存。

默认安装位置为 `%USERPROFILE%\.workbuddy\skills\长沙移动系统集团驳回数据Skill`，技能的 `name` 和 `display_name` 也使用这个中文名称。这是普通用户安装，不请求管理员权限，也不修改 WorkBuddy 的其他技能或配置。安装完成后在 WorkBuddy 刷新技能列表或重新打开应用。

从旧版英文目录升级时，安装器会将已注册的旧目录重命名为同级中文目录，保留整个目录中的配置、登录缓存和导出状态；重复升级继续使用中文目录。新旧目录同时存在时不会自动合并或覆盖，安装器会报告具体原因。

安装向导可填写手机号（可留空）和下载根目录；默认 `D:\报备\集团驳回`，没有 D 盘时默认使用“文档\报备\集团驳回”。目录不存在会自动创建。已有 `.env` 时整个配置文件原样保留，登录缓存及批次状态也保留。卸载不删除程序运行时生成的本机配置、缓存、历史状态和业务下载结果。

安装后的入口是 `scripts/run.cmd`；它使用内置 Node.js 并固定工作目录，不依赖全局 PATH 中的 Node.js、npm 或 pnpm。本机仍需已安装 Chrome 或 Edge；安装向导优先 Chrome，检测不到 Chrome 时选 Edge。开发源码目录使用相同入口，自动回退到 pnpm。

`test:installer` 使用单独的测试安装标识，把同一脚本构建的 EXE 安装到仓库 `build` 内的隔离目录，验证旧英文目录迁移到中文目录、离线运行、SEDP 转换、升级保留配置与登录状态、卸载保留业务数据。测试不调用生产门户、不写入真正的 WorkBuddy 技能目录，也不覆盖正式版卸载登记。

参考：[WorkBuddy 官方技能说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)、[Inno Setup 文件安装规则](https://jrsoftware.org/ishelp/topic_filessection.htm)。
