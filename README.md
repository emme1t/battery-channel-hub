# Battery Channel Hub

Battery Channel Hub（电池测试通道预约与使用看板）是一款本地离线 Electron 桌面工具，用于管理测试申请、子样品、设备与通道、普通测试预约、正在测试项目、长期存储、退回流程、测试人员和操作日志。

软件只管理业务状态，不直接连接、采集或控制真实测试设备。

## 主要能力

- 导入纵向申请单、横向 Excel 汇总、旧版 XLS 和 CSV。
- 按申请数量生成 `.001` 到 `.999` 的子样品编号。
- 为多个子样品分配独立通道，支持立即开始、预约、排队和冲突检查。
- 管理正在测试样品和长期存储样品，并支持完成、异常更新和退回申请。
- 使用 SQLite 保存业务状态，通过 revision、事务和审计记录保护一致性。
- 导出申请汇总、选中申请、使用记录、日志和测试及时率 PNG。
- 备份和恢复 `.batterydata` 或 JSON 数据包，并在恢复前校验内容。

## 环境要求

- Windows 10 或 Windows 11 x64
- Node.js 22 或项目锁文件兼容的更高版本
- npm

## 本地开发

```powershell
git clone https://github.com/emme1t/battery-channel-hub.git
Set-Location -LiteralPath '.\battery-channel-hub'
npm ci
$env:BATTERY_CHANNEL_DATA_DIR = Join-Path $env:TEMP 'battery-channel-hub-dev'
npm start
```

开发模式应使用独立数据目录。不要把测试或开发脚本指向正式业务数据。

## 测试

```powershell
npm run test:core
npm test
```

部分 Electron、Edge、工作流和性能测试运行时间较长，并会在被忽略的本地目录中生成证据。测试成功必须以目标提交上的新鲜命令输出为准，不能用历史报告代替。

`npm test`、`test:core` 和 Edge 回归命令会先执行 `fixtures:prepare`，从版本化压缩文件补齐 v0.4.2/v0.4.3 合成测试数据，并按原始 `SHA256SUMS.json` 校验。已有母版或清单不会被覆盖；已有文件哈希不符时停止并报错。真实运行数据库仍然不入库。直接运行依赖这些数据的 Node 测试前，可手动执行 `npm run fixtures:prepare`。

本次代码审查修复的定向 Electron 回归：

```powershell
npm run test:electron:review
```

## Windows 打包

```powershell
npm run dist:dir
npm run dist:installer
```

- `dist:dir` 生成 unpacked 目录，适合检查 `app.asar` 和资源闭包。
- `dist:installer` 生成 NSIS 安装程序。
- 安装后会创建主程序入口和标准卸载入口。
- `resources/使用说明` 中的两份说明及十个格式样例会复制到安装资源目录。
- 当前项目未配置代码签名证书；成功构建不等于已通过 Authenticode 或 SmartScreen 验证。

打包内容门禁：

```powershell
$env:BATTERY_PACKAGE_GATE = '1'
node --test tests/package-contents.test.mjs
```

## 数据与安全边界

打包程序把状态保存在 Electron `userData` 目录下的 `data` 子目录。卸载配置默认保留 AppData，防止卸载时误删业务数据；正式交付仍应在隔离 Windows 环境实际验证安装、启动、卸载和数据保留行为。

生产数据切换属于高风险操作。仓库中的切换脚本默认只执行 dry-run，只有操作者核对精确路径、外部备份、文件哈希、SQLite 完整性和进程状态后，才能明确添加 `--apply`。详见 [部署与回滚说明](docs/部署与回滚说明-v1.0.md)。

## 目录结构

```text
lib/                 设备与通道预设
src/domain/          纯业务规则
src/main/            SQLite、命令服务、导入导出和备份
src/renderer/        正式界面逻辑
scripts/             测试数据、回归、迁移和切换工具
tests/               单元、集成、工作流、Smoke 和性能测试
resources/使用说明/  用户说明、开发者说明和格式样例
```

本仓库不跟踪运行数据库、测试报告、构建产物、凭据或内部项目进度文件。
