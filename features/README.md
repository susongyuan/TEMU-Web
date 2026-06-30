# 功能分区索引

这个目录只做功能边界说明，不参与运行。现在线上入口仍然是 `src/server.js`、`public/app.js`、`src/data-loader.js`，不要为了改页面直接改模块名或移动运行文件。

## 00_shared_dashboard

公共看板能力。登录、操作记录、备注、批量处理、SKU-运营映射上传、数据库快照读取、Docker 部署都归这里。

## 01_price_display

前后端价格显示及预警功能。页面路径是 `/price`，接口是 `/api/price-products`。

以后晚上完善价格页，优先看这个目录里的说明，再改：

- `public/app.js` 里的 `PAGE_CONFIG.price`
- `src/data-loader.js` 里的价格读取、匹配、价格提醒逻辑
- `src/server.js` 里的 `/api/price-products`

## 02_inventory_listing_warning

库存上下架预警功能。页面路径是 `/inventory`，接口是 `/api/inventory-products`。

库存上下架依赖领星全状态数据和仓库库存快照，和价格页共用登录、备注、操作记录、负责人映射。

