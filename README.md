# 参数面去嵌台

本地 TypeScript + Node.js + SQLite 应用，用于把网络分析仪两端口测量参考面从夹具外端移到被测件引脚。页面使用浏览器原生 Canvas 绘制 Smith 轨迹、S21 幅相、群时延和回级联残差，不依赖外部绘图服务。

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run
corepack pnpm dev --host 127.0.0.1 --port 5545
```

打开 <http://127.0.0.1:5545>，页面标题应为“参数面去嵌台”。

SQLite 默认路径为 `data/deembed.sqlite`，可用 `DEEMBED_DB=/path/to/db.sqlite` 覆盖。首次启动发现数据库内无网络时，会自动导入 `fixtures/` 下的固定基准并创建两个方案。页面上的“清空并重放固定 fixture”会删除库内网络、方案和日志，再重新导入同一批 Touchstone；也可以调用 `POST /api/reset-and-replay`。

## 固定数据

- `fixtures/left-fixture-75ohm.s2p`：左夹具，75 Ω，15 个频点，8–116 MHz。
- `fixtures/right-fixture-50ohm.s2p`：右夹具，50 Ω，12 个频点，11–121 MHz。
- `fixtures/measurement-cascaded.s2p`：左夹具 + DUT + 右夹具的测量网络，21 个频点，40–50 MHz。
- `fixtures/dut-narrow-notch.s2p`：窄带串联 RLC 并联到地 DUT，谐振点 45 MHz。

左右夹具频率网格互不相同，也不同于 DUT/测量网格。固定测量网络由固定夹具在测量频点上复插值、重归一化后级联生成，因此验收时不会把不同数组按下标直接配对。45 MHz 的 T 矩阵条件数约为 `1.06e6`，超过默认近奇异阈值 `1e6`，但矩阵仍有限；该频点保留估计值和完整诊断，不使用相邻点或零矩阵填平。

可运行 `corepack pnpm generate:fixtures` 重新生成这些基准文件。

## 数据口径

- Touchstone 文件列序遵循两端口标准：`frequency S11 S21 S12 S22`。
- 程序内部矩阵按 `[S11, S12, S21, S22]` 存储为 2×2 复数矩阵。
- 内部频率单位为 Hz；Touchstone 的 `Hz/kHz/MHz/GHz` 选项只负责导入导出换算。
- 波定义固定为 generalized power wave：
  - `a = (V + Z0 I) / (2 sqrt(Re(Z0)))`
  - `b = (V - Z0* I) / (2 sqrt(Re(Z0)))`
  - 对实参考阻抗退化为常见功率波定义。
- 每次运行固定端口顺序 `1-2`、波定义、每端口目标参考阻抗、频率网格策略、容差和近奇异阈值。
- 先把测量和左右夹具重归一化到共同的每端口 `Z0`，再进行 T 矩阵级联与反演。
- 散射传输矩阵约定为 `[a1; b1] = T [b2; a2]`：
  - `T = [[1, -S22], [S11, -det(S)]] / S21`
  - 总网络为 `T_total = T_left T_dut T_right`
  - 去嵌为 `T_dut = T_left^-1 T_measured T_right^-1`
- 插值在每个 S 参数的实部和虚部上分别做线性插值，即复数直角坐标插值，不直接插值极坐标幅度/角度。
- 超出某个网络自身频率范围时，使用首尾两点的线性外推，并在该频点记录 `measurement`、`left` 或 `right` 外推标记。
- 回级联残差为 `max(abs(S_recombined - S_measured))`，逐频点与运行容差比较，默认容差 `1e-8`。

## 数值与物理诊断

数值状态和物理状态分字段报告，避免把有源/非互易网络与矩阵数值问题混为一谈。

- `stable`：所有相关 T 矩阵有限，条件数低于阈值。
- `near-singular`：条件数 `κ(T)=σmax/σmin` 达到阈值；保留结果、条件数、残差和消息。
- `singular`：转换或反演无法得到有限结果；`estimatedDut` 和残差为 JSON `null`，不写入零矩阵。
- `feasible`：无源检查通过。
- `infeasible`：S 参数最大奇异值大于 1，违反无源。
- 非互易误差 `|S12-S21|` 作为独立物理消息记录，不掩盖数值状态。

## 端口交换

端口交换同时交换波变量定义和 S 子矩阵，执行：

`S_swapped = P S P = [[S22,S21],[S12,S11]]`

同时交换每端口参考阻抗。新网络以 `*-swapped` 名称保存，可作为左/右夹具再运行。

## 页面与 API

页面支持：

- 粘贴导入 Touchstone 风格两端口文件。
- 选择左右夹具、频率对齐策略和每端口目标阻抗。
- 查看 Smith、幅相、群时延和残差图。
- 逐频查看条件数、残差、无源裕量、外推和诊断消息。
- 对两个已保存方案按完全相同频率比较最大复差和 RMS 复差。
- 导出完整 JSON 运行记录，或导出网络为 Touchstone。

常用 API：

- `GET /api/health`
- `GET /api/networks`
- `POST /api/networks/import`
- `POST /api/ports-swap`
- `POST /api/runs`
- `GET /api/runs/:runId`
- `GET /api/compare?baseline=...&comparison=...`
- `GET /api/export`
- `POST /api/reset-and-replay`

## 开发命令

```bash
corepack pnpm build          # 严格 TypeScript 检查
corepack pnpm test -- --run  # 自动化测试
corepack pnpm seed           # 导入固定 fixture 并写入演示方案
```

测试覆盖复直角插值与外推、Touchstone 标准列序、75 Ω→50 Ω 重归一化、端口交换、T 级联/反演、近奇异逐频诊断、硬奇异 `null` 保留、SQLite 清空重放和 HTTP API。
