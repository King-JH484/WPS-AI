# 测试指南

## 问题修复总结

已修复 `get_host_info` 工具的两个问题：
1. PDF 路径检测依赖错误条件导致失败
2. 缺少调试日志无法追踪问题

## 测试步骤

### 1. 加载新代码

**重要**: WPS 会缓存已加载的 JavaScript，必须完全退出后重新启动才能加载新代码。

```bash
# 确认代码已部署
ls -l ~/.anthony-ai/plugin-{wps,et,wpp,pdf}/js/tools/common.js

# 完全退出 WPS (不是关闭窗口，是退出应用)
# macOS: Cmd+Q 或右键 Dock 图标 → 退出
# Windows: 文件 → 退出

# 确认进程已退出
ps aux | grep wpsoffice | grep -v grep | grep -v appex

# 重新打开 WPS
open -a wpsoffice
```

### 2. 打开测试文档

```bash
# 打开一个 PDF 文件
open -a wpsoffice ~/Downloads/*.pdf

# 或打开 Word/Excel/PPT 文档
open -a wpsoffice ~/Documents/*.docx
```

### 3. 打开插件侧边栏

1. 在 WPS 功能区点击「Anthony AI」或「AI」按钮
2. 侧边栏应该出现在右侧（Word/Excel/PPT 嵌入，PDF 独立窗口）
3. 确认侧边栏已连接（不显示连接错误）

### 4. 测试工具调用

在侧边栏输入框输入任意问题，例如：
- **PDF**: "这个 PDF 有多少页"
- **Word**: "这个文档有多少字"
- **Excel**: "总共多少位嘉宾"
- **PPT**: "这个演示有多少张幻灯片"

### 5. 观察结果

**正常情况**:
- AI 应该在 1-2 秒内给出回复
- 不应该出现长时间"调用工具"的状态
- 回复应该包含文档信息（不是"未检测到文档"）

**异常情况**:
- 如果出现"一直在调用工具没有结果"，说明问题仍未解决
- 如果返回"未检测到文档"，说明路径检测失败

### 6. 检查调试日志

```bash
# 实时查看调试日志
tail -f ~/.anthony-ai/debug.log | grep get_host_info

# 查看最近的工具调用
tail -100 ~/.anthony-ai/debug.log | grep "get_host_info"
```

**应该看到的日志**:
```
[plugin-debug] YYYY-MM-DDTHH:mm:ss.sssZ get_host_info.start
[plugin-debug] YYYY-MM-DDTHH:mm:ss.sssZ get_host_info.hostInfo {"host":"pdf","label":"WPS PDF"}
[plugin-debug] YYYY-MM-DDTHH:mm:ss.sssZ get_host_info.hasApp true
[plugin-debug] YYYY-MM-DDTHH:mm:ss.sssZ get_host_info.pdf.robust "/Users/xxx/Downloads/test.pdf"
[plugin-debug] YYYY-MM-DDTHH:mm:ss.sssZ get_host_info.result {"host":"pdf","label":"WPS PDF","document":"/Users/xxx/Downloads/test.pdf"}
```

**关键检查点**:
- `get_host_info.result` 的 `document` 字段是否为 null
- 是否出现 `get_host_info.error`
- PDF 是否走到 `get_host_info.pdf.robust`

### 7. 检查迭代次数

```bash
# 查看最近一次会话的迭代次数
tail -100 ~/.anthony-ai/debug.log | grep "iteration.end" | tail -5
```

**正常情况**: iteration 应该在 1-5 之间  
**异常情况**: iteration 超过 10，说明仍在循环

## 问题排查

### 问题 A: 日志中没有 get_host_info.start

**原因**: WPS 还在使用旧代码  
**解决**: 
1. 确认已执行 `node plugin/tools/build-variants.js`
2. 完全退出 WPS (Cmd+Q)
3. 重新打开 WPS 和文档

### 问题 B: get_host_info.result 的 document 为 null

**原因**: 所有路径检测方法都失败了  
**排查**:
1. 确认文档确实已打开：`lsof -c wpsoffice | grep -E "\.(pdf|docx|xlsx|pptx)$"`
2. 检查是否有 `get_host_info.error` 日志
3. 检查 PDF 是否走到 `get_host_info.pdf.robust`

### 问题 C: 工具仍然无限循环

**原因**: 返回值仍让 AI 认为需要重试  
**排查**:
1. 查看 `get_host_info.result` 的完整内容
2. 确认 `host` 字段不是 "unknown"
3. 确认 `document` 字段不是 null
4. 如果以上都正常，问题可能在 AI 侧或工具描述

### 问题 D: 历史会话无法加载

**状态**: 这是独立问题，与 get_host_info 无关  
**原因**: 数据库缺少 conversations 表  
**临时方案**: 暂时无法加载历史会话，需要单独修复

### 问题 E: WPS 内存占用过高

**可能原因**:
1. 无限循环导致上下文累积（如果工具修复后应解决）
2. Chromium 子进程泄漏
3. PDF 渲染缓存未释放

**排查**:
```bash
# 监控内存变化
while true; do 
  ps aux | grep wpsoffice | grep -v grep | awk '{sum+=$6} END {printf "%s  WPS: %.2f GB\n", strftime("%H:%M:%S"), sum/1024/1024}'
  sleep 5
done
```

**临时解决**: 定期重启 WPS

## 成功标准

✅ AI 能正常回复问题，不出现工具循环  
✅ PDF/Word/Excel/PPT 文档都能正确识别  
✅ `get_host_info.result` 的 document 不为 null  
✅ 迭代次数 < 5  
✅ WPS 内存占用稳定在 1-3GB

## 失败后的操作

如果测试失败：

1. **收集完整日志**:
```bash
# 导出最近 500 行日志
tail -500 ~/.anthony-ai/debug.log > ~/Desktop/debug-export.log
tail -500 ~/.anthony-ai/server.log > ~/Desktop/server-export.log
```

2. **记录具体现象**:
- 测试的文档类型（PDF/Word/Excel/PPT）
- AI 的具体回复内容
- 迭代次数
- 日志中的 get_host_info.result 值

3. **恢复到之前的版本**:
```bash
cd ~/.local/github/WPS-AI
git checkout HEAD~1  # 回退一个提交
node plugin/tools/build-variants.js --out "$HOME/.anthony-ai" --port 3889
# 重启 WPS
```

## 联系方式

如有问题，提供：
1. 导出的日志文件
2. WPS 版本：`/Applications/wpsoffice.app/Contents/Info.plist` 中的 CFBundleShortVersionString
3. macOS 版本：`sw_vers`
4. 测试的文档类型
