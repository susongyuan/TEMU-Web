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
- 后台导出：价格页支持点击 `上传后台数据`，上传后的后台数据会保存在数据库中；后续可按单个店铺或单个店铺站点分批上传，本次文件涉及的店铺/站点会局部覆盖，其他店铺保留上次版本。未使用上传入口时，仍读取 `TEMU_BACKEND_EXPORT_FILE` 指定文件；未配置时优先读 `C:\Users\Administrator\Desktop\Ziniao_TEMU_Export_Output\TEMU_Product_Data.xlsx`。
- 价格同步只使用 TEMU 后台导出作为基准数据；领星价格数据不参与价格页。后台只取 `商品状态` 含 `在售` 的行，前端上传数据作为独立数据源保留，再和后台在售行匹配。
- 匹配：先限定同店铺+同站点，再用后台标题、后台中文/翻译标题、后台英文标题匹配前端标题/翻译标题；默认普通标题相似度阈值 45%，翻译标题阈值 40%，可用 `BACKEND_OFFICIAL_TITLE_MATCH_THRESHOLD`、`BACKEND_OFFICIAL_TRANSLATED_TITLE_MATCH_THRESHOLD` 调整。
- 无图片时标题匹配会额外检查长度：普通标题默认要求有效字符长度比例不低于 50% 或长度差不超过 24；翻译标题默认不低于 40% 或长度差不超过 36。可用 `PRICE_TITLE_MIN_LENGTH_RATIO`、`PRICE_TRANSLATED_TITLE_MIN_LENGTH_RATIO`、`PRICE_TITLE_MAX_LENGTH_DIFF`、`PRICE_TRANSLATED_TITLE_MAX_LENGTH_DIFF` 调整。
- 标题翻译：默认先用本地商品词典抽取高信号关键词，再把词典覆盖不到的标题交给自建 `LibreTranslate`；服务器版 `docker-compose.server.yml` 会启动 `libretranslate` 容器、保存语言包，并把翻译缓存持久化到 `/app/data`。也可用 `PRICE_TITLE_TRANSLATION_PROVIDER` 指定 `libretranslate`、`microsoft`、`google`、`google-public`、`local-keyword`、`off`，用 `PRICE_TITLE_TRANSLATION_LOCAL_FIRST=false` 关闭词典优先。
- 店铺 ID 映射：`634418219290009=YYcareU`、`634418228142942=Drevalora`、`634418225384418=VastOrigin`、`634418215126235=uyoyous`、`634418219730772=Ruralityro`。
- 页面展示：申报价列始终显示后台原始申报价。
- 提醒计算：先把 TEMU 前端价统一换算成 USD；申报价也按 USD 口径计算成本价，德国站 `申报价*1.19`、英国站 `申报价*1.20`、其他站点原始申报价；按 `前端USD价 / 成本价USD - 1` 判断是否超过 20%。
- 处理状态：价格页只有 `前端超价20%` 进入 `未完成`，正常利润价差、缺价、未匹配只作为信息展示，默认 `无需处理`。
- 未匹配：后台有前端没有标记 `后台未匹配前端`；前端有后台没有标记 `前端未匹配后台`。
- 如果后台导出缺少某个店铺/站点的在售行，前端数据会保留为 `前端未匹配后台`，不会强行跨店铺或跨站点匹配。

## 库存页

- 路径：`/inventory`
- 领星筛选：今日、全状态、全部店铺。
- 后台导出：全量参与库存上下架页。按 `SPU ID` 覆盖领星站点、状态、申报价；领星没有该 SPU 时新增后台行。
- 库存来源：万邑通、出口易、4PX、谷仓数仓快照。
- 判断单位：`链接/SPU + 区域组`。一个链接下有多个 SKU 时，按整条链接判断。
- 区域组：欧区国家归 `欧区`；其他站点和国家归 `美国/Global`。
- 同一条链接在同一区域组内，只要任意一个 SKU 有同区可用库存，该链接就不提醒无库存。
- 没有申报价且没有活动价的领星链接不参与库存核对。
- 仓库查到的库存默认按 TEMU 库存处理，但必须和链接区域组同区匹配；异区库存只展示，不计入可售库存。
- 仓库区域识别支持常见仓库代码：`UK/UKTW/UKGF/UK0001/GBLONA/GBLTNA` 按英国/欧区，`DE` 按欧区，`US/USEA/USWE/USTX/USKY/USWC` 按美国/Global。
- 强提醒：有 `已加入站点` 链接，但链接下全部 SKU 同区域组可用库存为 0，标记 `有在卖但没可用库存`。
- 需处理：没有任何 `已加入站点` 状态，但链接下 SKU 同区域组可用库存大于 0，标记 `有库存但无在卖链接`。
- 需处理前会继续按“有库存 SKU + 同区域组”反查所有店铺；如果该 SKU 已在任意店铺同区域销售，当前下架链接不提醒，覆盖情况写入提醒原因。
- 异区库存：单独显示，不计入当前区域组可售库存。
- 仓库地区待确认：SKU 有可用库存但仓库代码/国家无法稳定识别时，不直接标记 `有在卖但没可用库存` 或 `有库存但无在卖链接`，只展示 `仓库地区待确认`，避免误报给运营。

## 筛选导出

- 支持 Excel 式下拉勾选筛选。
- 不同筛选条件之间取交集，同一筛选条件内多选取并集。
- 支持导出当前筛选结果。

常用筛选字段：

- 价格页：店铺/区域、店铺、区域、站点、前端站点、匹配状态、价格提醒、对比价类型、超价 20%。
- 库存页：店铺/区域、店铺、区域、站点、区域组、领星状态、处理动作、仓库地区、仓库来源。

## 当前能力

- 显示商品图片、SPU、SKU、SKC、标题、店铺、区域、站点。
- 显示申报价、活动价、前端价、价格差异。
- 显示仓库来源、链接同区可用库存、链接 SKU 明细、同区可用库存、异区可用库存、在库库存、冻结/待发库存、领星状态码、库存提醒原因。
- 不同筛选条件之间取交集，同一筛选条件内多选取并集。
- 支持导出当前筛选结果。

## TEMU 官方数据

如果后续拿到 TEMU 前台 listing 数据，放到 `data\temu_official_products.csv` 或 `data\temu_official_products.json`。本机入库脚本会在价格页数据里用标题/翻译标题、店铺、站点和后台导出数据做匹配。

当前仓库只保留 `data\temu_official_products.example.csv` 作为字段示例，真实官方数据不提交到 Git。

也可以通过 Web 上传：

- 价格页点击 `上传前端价格`。
- 支持 `.csv`、`.xlsx`、`.xls`、`.json`。
- 表头至少包含价格列，以及标题、SKU 货号、商品 ID 或图片列之一；图片列可用 `图片`、`图片链接`、`图片URL`、`前端图片`、`前端图片链接`、`image`、`image_url`、`img`、`主图`。
- 店铺列可用 `店铺ID`、`mall_id`、`mallId`，也可直接放 TEMU 店铺链接。
- 前端站点列可用 `前端站点`、`TEMU站点`、`官方站点`、`站点`、`site`、`country`、`countryCode`。没有站点列时按价格货币兜底：`£=GB`、`$=US`、`€=EU`；欧元只能识别欧区，不能自动区分德国/法国/西班牙，精确国家必须上传站点列。
- 匹配顺序：同店铺+同站点标题/翻译标题匹配，普通标题默认阈值 45%，翻译标题默认阈值 30%。
- 上传后自动覆盖 `data\temu_official_products.csv`，并基于数据库最新 `price` 快照重建价格页数据。
- 价格页点击 `上传后台数据` 可以维护后台基准数据。建议每次上传文件只包含要更新的店铺或店铺站点；系统按店铺+站点局部替换旧后台行，避免单店铺导出覆盖掉其他店铺。

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
