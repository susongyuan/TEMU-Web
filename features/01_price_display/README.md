# 前后端价格显示及预警

## 业务边界

这个功能只负责价格同步查看和价格异常提醒。

页面路径：

```text
/price
```

接口：

```text
/api/price-products
```

数据快照模式：

```text
price
```

## 主要文件

- 前端页面配置：`public/app.js` -> `PAGE_CONFIG.price`
- 后端接口：`src/server.js` -> `/api/price-products`
- 数据生成：`src/data-loader.js` -> `loadPriceData()`
- 价格匹配：`src/data-loader.js` -> `matchPriceRows()`
- 价格提醒：`src/data-loader.js` -> `referencePrice()`、`priceStatus()`

## 当前数据口径

- TEMU 后台数据：只取后台导出中 `商品状态` 含 `在售` 的行。
- TEMU 前端数据：`modules/temu-price-dashboard/data/temu_official_products.csv|json` 或前端上传后保存在数据库中，作为独立数据源和后台在售行匹配。
- 负责人映射：最新的 `平台SKU_*.xlsx` 或 `SKU-运营映射表.xlsx`
- 普通标题匹配默认阈值 45%，翻译标题匹配默认阈值 30%。

价格提醒规则：

- 以后台申报价作为对比基准
- TEMU 前端价超过后台对比价 20% 时标记 `前端超价20%`
- 其他价差标记 `正常价差`，仅作信息展示，默认 `无需处理`
- 只有 `前端超价20%` 会进入 `未完成`，需要运营处理

## 后续完善时优先改这里

如果只是完善“前后端价格显示”，优先改 `PAGE_CONFIG.price` 和 `loadPriceData()` 相关逻辑，不要改库存上下架规则。
