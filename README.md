# 参数面去嵌台（Reference-plane De-embed Bench）

两端口射频网络的**参考面移动**工具：把测量参考面从仪表端口移到被测件（DUT）引脚。
支持两端口 S 参数网络的**级联、反演、参考阻抗重归一化**，对数值不稳定与物理不可行**分开、逐频点**报告。

本地服务（Node.js + TypeScript + 内置 `node:sqlite` + 原生 Canvas 页面，无前端构建步骤）。

---

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run
corepack pnpm dev --host 127.0.0.1 --port 5545
```

浏览器访问 <http://127.0.0.1:5545>，页首应显示 **“参数面去嵌台”**。

要求 Node ≥ 22.5（使用内置 `node:sqlite`；开发机验证版本 Node v26）。

## 固定 fixture 与验收数据

随仓库交付、用于可重放验收（生成脚本 `scripts/gen-fixtures.ts`，可用 `pnpm gen:fixtures` 重新生成）：

| 文件 | 角色 | 频率网格 | 模型 |
| --- | --- | --- | --- |
| `data/fixtures/left-fixture-3mhz.s2p` | 左夹具 | **3 MHz**，0.08–4.2 GHz，1374 点 | 50Ω 有耗传输线，t_delay=0.4 ns，α=0.02 Np |
| `data/fixtures/right-fixture-7mhz.s2p` | 右夹具 | **7 MHz**，0.05–4.5 GHz，637 点 | 52Ω 有耗传输线，t_delay=0.25 ns，α=0.03 Np |
| `data/measured/measured-10mhz.s2p` | 测量面 | 10 MHz，0.1–4 GHz，391 点 | `L · DUT · R` 合成（夹具先插值到 10 MHz 网格级联） |
| `data/dut/dut-shunt-notch-10mhz.s2p` | DUT 真值 | 10 MHz，391 点 | 并联 RLC 串联支路接地，陷波于 **1.0 GHz** |

DUT 陷波：`R=0.02 Ω, L=1 nH, C=25.33 pF`（谐振 1 GHz）。陷波中心 `|S21|≈8e-4`，
`S→T` 条件数约 **2.5×10⁷**；0.98/0.99/1.00/1.01/1.02 GHz 五个点落入近奇异窄带，逐频点报告。

> 注意左右夹具网格（3 MHz / 7 MHz，覆盖区间也不同）与测量网格（10 MHz）**两两不同**，
> 这是复插值与外推验收所要求的。

## 数据口径（每次去嵌固定并随结果记录）

- **端口顺序**：端口 1 在左（输入），端口 2 在右（输出）。
- **波定义**：功率波 `a`（入射）/`b`（出射），`a=(V+z0 I)/(2√z0)`，`b=(V−z0 I)/(2√z0)`。
- **S 排列**：`S=[[S11,S12],[S21,S22]]`；参考阻抗 `z0` 为逐端口实数（Touchstone v1 同阻抗）。
- **T（传输/波级联）约定**：`[a1; b1] = T [b2; a2]`，于是信号自左向右级联时
  `T_total = T_left · T_right`。
  - `T = [[−detS/S21, S11/S21],[−S22/S21, 1/S21]]`（直通 thru 对应单位阵）。
- **去嵌**：测量面 `T_M = T_L · T_DUT · T_R`，故 `T_DUT = T_L⁻¹ · T_M · T_R⁻¹`。
- **重归一化**：由功率波定义严格推导，令 `g=√(Z/z0)`、`A=(g+1/g)/2`、`B=(1/g−g)/2`，
  则 `S'=(B+A S)(A+B S)⁻¹`（对角、逐端口）；等阻抗时退化为 `(S−R)(I−RS)⁻¹`。
- **端口交换**：同时交换入射与反射定义，等价于 `S' = P S P = [[S22,S21],[S12,S11]]`，
  端口阻抗随顺序对调。
- **频率对齐**：**绝不按数组下标相乘**。插值在复数**直角分量 (re, im)** 上逐元素线性进行；
  目标频点落在源网格外时按端部斜率**外推并逐点标记 `extrapolated`**（记录外推距离）。
  策略：`measured`（默认，以测量网格为准）/ `union` / `left` / `right`。

## 数值不稳定 vs 物理不可行（分列）

每个频点独立诊断，**不用零矩阵、不用相邻频点填平**：

- 数值状态：`ok / interpolated / extrapolated / near_singular / unstable / exact_singular`
  - 判据：`S→T`/求逆条件数（默认预警 1e5、失败 1e8），`S21=0`（或 `T22=0`）为严格奇异；
  - `exact_singular` 频点 `dutS=null`（**null，不是零矩阵**），消息中明确说明不填平；
  - 每个点保留 cond(T) 测量/左/右、外推标记、回验残差、消息列表。
- 物理可行性（独立字段）：`sᴴs` 最大特征值 > 1 判定非无源（物理不可行），
  互易性用 `|S12−S21|` 判定。一个频点可以“数值良态但物理不可行”，二者不互相覆盖。
- **回级联回验**：对每个可恢复点计算 `L · DUT_est · R` 与测量网络的
  Frobenius 相对残差。内置数据集最大残差约 **1e-13**（容差默认 1e-9）。

页面图表：Smith 圆图（S11 轨迹，奇异点红色）、S 参数幅度(dB)/相位、群时延
（解卷绕相位中心差分，`τg=−d∠S21/dω`）、逐频点回验残差、逐点诊断表。
方案 A/B 可按**频率值**内连接，查看该频点复矩阵差。

## 页面操作

1. 在“夹具与口径”选择测量网络、左右夹具模型、对齐策略、阈值，点“去嵌并保存方案”；
2. Smith/幅相/群时延/残差即时绘制，诊断表列出全部非 `ok` 与残差点；
3. 建两个方案（例如 B 用“左右对调”按钮交换夹具），在“两案对比”输入频率逐点查看差异；
4. “导出运行记录 JSON”下载全部 fixture 原文与 runs（请求+报告）；
5. 清空数据库后，在“重新导入并复算”选择该 JSON：fixture 重新导入，runs **由引擎重算**，
   并把新回验残差与导出记录比对（`matched` 字段），完成复核。

## HTTP API

- `GET /api/health`、`GET /api/fixtures`、`GET /api/fixtures/:name`
- `POST /api/fixtures`（body：`{name, role, touchstone}`）
- `POST /api/runs`（body：`{name, measuredName, leftName, rightName, strategy, condWarn?, condFail?, roundtripTol?, targetZ0?}`）
- `GET /api/runs`、`GET /api/runs/:id`、`GET /api/compare/:aId/:bId`
- `GET /api/export`、`POST /api/reimport`（body：`{bundle, wipe}`）

## 清空数据库后重新导入复核（命令行示例）

```bash
# 数据库默认 data/deembed.db（可用环境变量 DEEMBED_DB 覆盖）
curl -s http://127.0.0.1:5545/api/export -o runs.json
# 删除/移走 data/deembed.db* 后重启服务即得到空库；随后：
curl -s -X POST http://127.0.0.1:5545/api/reimport \
  -H 'content-type: application/json' \
  -d "$(node -e 'const b=require("./runs.json");console.log(JSON.stringify({bundle:b,wipe:true}))')"
```

返回的 `replays[*].matched` 为 `true`、`maxRoundtripRel` 在 1e-10 量级即复核通过。

## 代码结构

```
src/
  complex.ts     复数（全程直角分量）
  cmat.ts        2x2 复矩阵、求逆与条件数诊断
  rf.ts          S<->T、级联、反演、端口交换、重归一化、物理诊断
  grid.ts        频率对齐（复直角插值/外推标记）
  touchstone.ts  Touchstone v1（RI/MA/DB）读写
  models.ts      解析模型（有耗传输线、并联 RLC 陷波）
  deembed.ts     去嵌引擎：逐频点诊断 + 回级联回验
  measure.ts     群时延/幅相/Smith
  compare.ts     两方案按频点差异
  db.ts          SQLite 持久化、导出/清空/重导入重放
server/          HTTP 服务与编排
web/             操作页面（原生 Canvas）
scripts/         固定 fixture 生成
tests/           vitest（32 项：复插值/外推、S<->T、级联反演、端口交换、
                 重归一化、逐奇异点、回级联残差、Touchstone、清空重导入）
```

## 常用脚本

- `pnpm dev --host 127.0.0.1 --port 5545`：启动本地服务
- `pnpm test -- --run`：一次性测试（默认 `pnpm test` 为 watch 模式）
- `pnpm typecheck`：严格 TypeScript 检查
- `pnpm gen:fixtures`：重新生成 `data/` 下固定 fixture
