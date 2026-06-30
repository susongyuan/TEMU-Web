# TEMU 运营看板

本模块提供长期打开的本地网页，给运营分开查看价格同步和库存上下架提醒。

地址：

- 价格页：`http://127.0.0.1:3106/price`
- 库存页：`http://127.0.0.1:3106/inventory`
- 根路径默认进入价格页：`http://127.0.0.1:3106`

## 数据来源

- Web 看板默认只读 MySQL 最新快照：`dashboard_snapshots`、`dashboard_rows`。
- 本机采集端读取领星、仓库、TEMU 官方文件，并把最终看板数据导入 MySQL。
- 本地调试可设置 `DATA_SOURCE=file`，临时回到文件读取模式。

仓库库存来自数仓只读查询。领星定时抓取每 4 小时执行一次，会先更新价格页数据，再更新库存页全状态数据，最后同步刷新库存文件。
刷新完成后会执行 `modules\temu-price-dashboard\scripts\import_dashboard_snapshot.js`，覆盖 MySQL 中的最新看板快照。服务器只读这些快照，不执行爬虫、不写数据库。

## 运行

```powershell
cd "C:\Users\Administrator\Desktop\project\6\前后端价格显示及预警功能\modules\temu-price-dashboard"
npm install
npm run init:db
npm run import:db
npm start
```

设置登录后自动启动：

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -File .\scripts\setup_dashboard_task.ps1
```

## 价格页

- 路径：`/price`
- 领星筛选：今日、已加入站点、全部店铺。
- 匹配：标题优先，标题不匹配再尝试 SKU。
- 后台对比价：活动价优先；没有活动价时使用申报价。
- 提醒：TEMU 前端价大于后台对比价 20% 时标记 `前端超价20%`。
- 未匹配：领星有官方没有标记 `领星未匹配官方`；官方有领星没有标记 `官方未匹配领星`。

## 库存页

- 路径：`/inventory`
- 领星筛选：今日、全状态、全部店铺。
- 库存来源：万邑通、出口易、4PX、谷仓数仓快照。
- 判断单位：`链接/SPU + 区域组`。一个链接下有多个 SKU 时，按整条链接判断。
- 区域组：欧区国家归 `欧区`；其他站点和国家归 `美国/Global`。
- 同一条链接在同一区域组内，只要任意一个 SKU 有同区可用库存，该链接就不提醒无库存。
- 没有申报价且没有活动价的领星链接不参与库存核对。
- 仓库查到的库存默认按 TEMU 库存处理，但必须和链接区域组同区匹配；异区库存只展示，不计入可售库存。
- 强提醒：有 `已加入站点` 链接，但链接下全部 SKU 同区域组可用库存为 0，标记 `有在卖但没可用库存`。
- 需处理：没有任何 `已加入站点` 状态，但链接下 SKU 同区域组可用库存大于 0，标记 `有库存但无在卖链接`。
- 需处理前会继续按“有库存 SKU + 同区域组”反查所有店铺；如果该 SKU 已在任意店铺同区域销售，当前下架链接不提醒，覆盖情况写入提醒原因。
- 异区库存：单独显示，不计入当前区域组可售库存。

## 筛选导出

- 支持 Excel 式下拉勾选筛选。
- 不同筛选条件之间取交集，同一筛选条件内多选取并集。
- 支持导出当前筛选结果。

常用筛选字段：

- 价格页：店铺/区域、店铺、区域、站点、匹配状态、价格提醒、对比价类型、超价 20%。
- 库存页：店铺/区域、店铺、区域、站点、区域组、领星状态、处理动作、仓库地区、仓库来源。

## 当前能力

- 显示商品图片、SPU、SKU、SKC、标题、店铺、区域、站点。
- 显示申报价、活动价、前端价、价格差异。
- 显示仓库来源、链接同区可用库存、链接 SKU 明细、同区可用库存、异区可用库存、在库库存、冻结/待发库存、领星状态码、库存提醒原因。
- 不同筛选条件之间取交集，同一筛选条件内多选取并集。
- 支持导出当前筛选结果。

## TEMU 官方数据

如果后续拿到 TEMU 前台 listing 数据，放到 `data\temu_official_products.csv` 或 `data\temu_official_products.json`。本机入库脚本会在价格页数据里用标题、SKU 和领星数据做匹配。

当前仓库只保留 `data\temu_official_products.example.csv` 作为字段示例，真实官方数据不提交到 Git。

也可以通过 Web 上传：

- 价格页点击 `上传前端价格`。
- 支持 `.csv`、`.xlsx`、`.xls`、`.json`。
- 表头至少包含价格列，以及标题、SKU 货号或商品 ID 之一。
- 上传后自动覆盖 `data\temu_official_products.csv`，并基于数据库最新 `price` 快照重建价格页数据。

程序上传接口：

```http
POST /api/temu-official-products/upload
Authorization: Bearer <操作人authToken或TEMU_OFFICIAL_UPLOAD_TOKEN>
X-Upload-Filename: temu_front_price.csv
Content-Type: text/csv
```

如果使用操作人账号，先调用 `/api/operators/login` 获取 `authToken`。如果给爬虫程序配置专用 token，在服务器 `.env` 里设置 `TEMU_OFFICIAL_UPLOAD_TOKEN`。

## 部署

Docker 只打包 Web 看板，不包含领星爬虫、仓库刷新脚本、浏览器运行目录、TEMU 前台探测脚本和历史数据。

详见 `docs\部署说明.md`。
