# 库存上下架预警

## 业务边界

这个功能只负责库存和上下架状态核对。

页面路径：

```text
/inventory
```

接口：

```text
/api/inventory-products
```

数据快照模式：

```text
inventory
```

## 主要文件

- 前端页面配置：`public/app.js` -> `PAGE_CONFIG.inventory`
- 后端接口：`src/server.js` -> `/api/inventory-products`
- 数据生成：`src/data-loader.js` -> `loadInventoryData()`
- 库存行标准化：`src/data-loader.js` -> `normalizeInventory()`
- 上下架提醒：`src/data-loader.js` -> `stockAction()`、`stockCheckType()`
- 仓库库存刷新：`modules/warehouse-inventory-monitor`

## 当前数据口径

- 领星全状态数据：`input/在售/领星_TEMU_今日全状态_全店铺.csv`
- 仓库库存快照：`modules/warehouse-inventory-monitor/data/warehouse_inventory_latest.csv`
- 状态 `已加入站点` 才按在卖处理
- `待下首单` 按下架处理
- 核价未通过在入库/快照前过滤，不进入处理列表
- 有可用库存但没有任何同区在卖链接，提醒 `有库存但无在卖链接`
- 有在卖链接但同区可用库存为 0，提醒 `有在卖但没可用库存`

## 修改原则

只改价格页时不要动这里。这里的规则会直接影响运营上下架提醒数量，改动后需要重新导入快照并核对误报。

