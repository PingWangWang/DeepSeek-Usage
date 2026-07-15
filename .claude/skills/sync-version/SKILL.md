---
name: sync-version
description: 代码修改后同步版本号到 .user.js、.meta.js、README.md 三个文件
---

# 同步版本号到三个文件

代码修改后，同步更新版本号到三个文件中。

## 输入

参数格式：`<bump_type|version>`，其中：

- **bump_type**: `patch`（默认，1.14.0→1.14.1）、`minor`（1.14.0→1.15.0）、`major`（1.14.0→2.0.0）
- **version**: 直接指定版本号，如 `1.15.0`

省略参数默认为 `patch`。

## 执行步骤

### 步骤 1：读取当前版本号

从 `DeepSeek-Usage.user.js` 第 5 行提取当前版本：

```
// @version      1.14.1
```

读取格式：`x.y.z`

### 步骤 2：计算新版本号

如果参数是 bump_type：

- `patch`: z += 1（如 1.14.0 → 1.14.1）
- `minor`: y += 1, z = 0（如 1.14.0 → 1.15.0）
- `major`: x += 1, y = 0, z = 0（如 1.14.0 → 2.0.0）

如果参数是 version 字符串（匹配 `\d+\.\d+\.\d+`），直接使用。

### 步骤 3：更新三个文件

使用 `edit_file` 或 `multi_edit` 逐文件更新：

| 文件 | 匹配文本（old_string） | 替换文本（new_string） |
|------|----------------------|----------------------|
| `DeepSeek-Usage.user.js` | `// @version      旧版本号` | `// @version      新版本号` |
| `DeepSeek-Usage.meta.js` | `// @version      旧版本号` | `// @version      新版本号` |
| `README.md` | `[![Version](https://img.shields.io/badge/version-旧版本号-blue)]()` | `[![Version](https://img.shields.io/badge/version-新版本号-blue)]()` |

> **注意**：DeepSeek-Usage.user.js 和 DeepSeek-Usage.meta.js 的 @description 内容不同（.user.js 含详细功能描述，.meta.js 为简短描述），不要修改 @description 行。

### 步骤 4：验证

用 `grep` 或 `Select-String` 验证三处均已更新为新版本号。

### 步骤 5：输出

输出格式：

```
版本号已同步：旧版本号 → 新版本号
- DeepSeek-Usage.user.js ✅
- DeepSeek-Usage.meta.js ✅
- README.md ✅
```
