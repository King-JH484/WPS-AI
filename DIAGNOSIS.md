# 问题诊断报告

## 当前问题

1. **工具无限循环** - `get_host_info` 被调用 60+ 次，AI 不断重试
2. **历史会话无法加载** - 用户报告会话记录加载失败
3. **WPS 内存占用异常** - 用户报告曾达到 8.4GB（正常应为 1-2GB）

## 问题分析

### 工具循环的可能原因

从日志 `debug.log` 和 `server.log` 分析：

- `get_host_info` 每次调用在几毫秒内完成
- 工具执行成功（没有异常或超时）
- AI 看到返回值后立即再次调用
- 这表明**返回值让 AI 认为需要重试**

可能的触发条件：
1. 返回 `{host: "unknown", document: null}` - AI 认为没检测到文档
2. 返回值格式异常 - AI 无法解析
3. 工具描述与返回值不匹配 - AI 认为没拿到预期数据

### 历史会话加载问题

数据库检查结果：
```bash
sqlite3 ~/.anthony-ai/anthony.db ".tables"
# 输出：kv

sqlite3 ~/.anthony-ai/anthony.db "SELECT COUNT(*) FROM conversations;"
# 错误：no such table: conversations
```

**根因**：数据库只有 `kv` 表，没有 `conversations` 表。这可能是：
- 会话存储方式changed
- 数据库结构不兼容
- 历史版本遗留问题

### 内存占用异常

用户报告 WPS 占用 8.4GB，但我测试时只有 1.6GB。可能触发条件：
- 工具无限循环导致内存泄漏
- 会话上下文累积（68 次迭代的完整历史）
- PDF 渲染缓存未释放
- Chromium 子进程累积

## 已实施的修复

### 1. PDF 路径检测优化

**文件**: `plugin/js/tools/common.js`  
**修改**: `get_host_info` 工具的 PDF 处理逻辑

**修复前**:
```javascript
} else if (info.host === "pdf" && global.WpsAiHostPdf?.getActivePdfPath) {
  docName = await global.WpsAiHostPdf.getActivePdfPath();
} else if (app?.ActivePDF) {
  docName = app.ActivePDF.Name || app.ActivePDF.FileName;
```

**问题**: 条件 `info.host === "pdf"` 依赖 `detectHostFromApp()` 正确识别，但 PDF 场景下该函数可能返回 "unknown"

**修复后**:
```javascript
// 先尝试 PDF 的健壮方法（不依赖 host 检测）
if (global.WpsAiHostPdf?.getActivePdfPath) {
  const pdfPath = await global.WpsAiHostPdf.getActivePdfPath();
  if (pdfPath) {
    docName = pdfPath;
    debug("get_host_info.pdf.robust", pdfPath);
  }
}

// 如果 PDF 方法没取到，按宿主类型尝试
if (!docName) {
  if (app?.ActiveWorkbook) {
    docName = app.ActiveWorkbook.Name;
  } else if (app?.ActivePresentation) {
    docName = app.ActivePresentation.Name;
  } else if (app?.ActiveDocument) {
    docName = app.ActiveDocument.Name;
  } else if (app?.ActivePDF) {
    docName = app.ActivePDF.Name || app.ActivePDF.FileName;
  } else if (app?.ActivePdf) {
    docName = app.ActivePdf.Name || app.ActivePdf.FileName;
  }
}
```

**优势**:
- 不依赖 `info.host` 的准确性
- 优先使用健壮的 `getActivePdfPath()`（尝试 6 个属性名 + lsof 兜底）
- 添加详细调试日志

### 2. 添加调试日志

在工具处理流程中添加了多个调试点：
- `get_host_info.start` - 工具开始执行
- `get_host_info.hostInfo` - 宿主检测结果
- `get_host_info.hasApp` - Application 对象是否可用
- `get_host_info.pdf.robust` - PDF 健壮方法取到的路径
- `get_host_info.excel/ppt/word/pdf.direct` - 各宿主直接取到的文档名
- `get_host_info.error` - 异常信息
- `get_host_info.result` - 最终返回值

**作用**: 可以追踪工具执行的每一步，定位问题根源

## 下一步诊断

### 需要验证的问题

1. **工具返回值是什么？**
   - 检查 `debug.log` 中 `get_host_info.result` 的值
   - 确认是否真的返回 `{host: "unknown", document: null}`

2. **为什么 AI 会无限重试？**
   - 查看工具 schema 定义
   - 检查 AI prompt 对工具返回值的处理逻辑
   - 是否有重试机制bug

3. **会话加载为什么失败？**
   - 检查数据库 schema
   - 查找会话存储逻辑
   - 确认 KV 表中的会话数据格式

4. **内存为什么会飙升？**
   - 监控长时间运行时的内存变化
   - 检查是否有资源未释放
   - 查看 Chromium 子进程数量

### 诊断脚本

创建一个完整的诊断脚本，在用户环境运行：

```bash
#!/bin/bash
# diagnosis.sh - WPS AI 问题诊断脚本

echo "=== WPS AI 诊断报告 ==="
echo "时间: $(date)"
echo

echo "1. 服务状态"
ps aux | grep -E "(proxy-server|wpsoffice)" | grep -v grep
echo

echo "2. 内存占用"
ps aux | grep wpsoffice | grep -v grep | awk '{sum+=$6} END {printf "WPS 总内存: %.2f GB\n", sum/1024/1024}'
echo

echo "3. 打开的 PDF 文件"
lsof -c wpsoffice 2>/dev/null | grep "\.pdf$"
echo

echo "4. 数据库状态"
sqlite3 ~/.anthony-ai/anthony.db ".tables"
sqlite3 ~/.anthony-ai/anthony.db "SELECT COUNT(*), SUM(length(value)) FROM kv;"
echo

echo "5. 最近的工具调用"
tail -50 ~/.anthony-ai/debug.log | grep "get_host_info"
echo

echo "6. 服务日志错误"
tail -100 ~/.anthony-ai/server.log | grep -iE "(error|exception|failed)"
echo

echo "=== 诊断完成 ==="
```

## 临时解决方案

在找到根本原因前，用户可以采取以下临时措施：

1. **停止无限循环**:
   - 关闭 WPS 侧边栏
   - 刷新页面或重启 WPS

2. **释放内存**:
   - 完全退出 WPS (Cmd+Q)
   - 重启后端服务：`launchctl kickstart -k gui/$(id -u)/com.anthony-ai.server`

3. **清理数据**:
   - 备份数据库：`cp ~/.anthony-ai/anthony.db ~/.anthony-ai/anthony.db.bak`
   - 清理 WAL 日志：`sqlite3 ~/.anthony-ai/anthony.db "PRAGMA wal_checkpoint(TRUNCATE);"`

## 待办事项

- [ ] 用户重启 WPS，加载新代码
- [ ] 检查调试日志，确认工具实际返回值
- [ ] 找到 AI 无限重试的触发条件
- [ ] 修复会话加载问题
- [ ] 排查内存泄漏根源
- [ ] 添加工具调用次数限制（防护机制）
