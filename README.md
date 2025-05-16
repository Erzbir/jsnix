一个运行在浏览器的模拟终端, 用作 banner, 不需要任何依赖

模拟了 Linux 的一些系统调用, 由于水平有限, 并非完全模拟

目前尚未完善, 也有很多功能都没有实现

可以把这个放在你的博客:

<img src="preview/img1.png" alt="img1">
<img src="preview/img2.png" alt="img2">

## 使用方法

1. 使用了 ES Modules, 使用 esbuild 构建后直接将 script 标签插入博客

2. 在你需要展示的位置插入一个标签: `<div id=terminal-banner></div>`

id 值可以通过 [config.js](config.js) 中的 `hook` 字段自定义