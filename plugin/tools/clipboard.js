const { spawnSync } = require("child_process");

function clipboardImageType(mimeOrPath = "") {
  const raw = String(mimeOrPath || "").toLowerCase();
  if (raw.includes("png") || raw.endsWith(".png")) return "PNGf";
  if (raw.includes("jpeg") || raw.includes("jpg") || raw.endsWith(".jpeg") || raw.endsWith(".jpg")) return "JPEG";
  return "";
}

function buildClipboardReadCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") return { cmd: "/usr/bin/pbpaste", args: [] };
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      // 用 [Console]::Out.Write 直接写出，避免 PowerShell 默认输出给字符串补一个尾随 \r\n
      // ——那个尾随换行会让"同一行粘贴"莫名多出一行。[string] 转换保证空剪贴板写出空串不报错。
      args: ["-NoProfile", "-NonInteractive", "-Command", `${windowsUtf8ConsolePreamble()} [Console]::Out.Write([string](Get-Clipboard -Raw))`]
    };
  }
  if (env.WAYLAND_DISPLAY) return { cmd: "wl-paste", args: ["--no-newline"] };
  if (env.DISPLAY) return { cmd: "xclip", args: ["-selection", "clipboard", "-out"] };
  return null;
}

function buildClipboardWriteCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") return { cmd: "/usr/bin/pbcopy", args: [] };
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `${windowsUtf8ConsolePreamble()} $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text`]
    };
  }
  if (env.WAYLAND_DISPLAY) return { cmd: "wl-copy", args: [] };
  if (env.DISPLAY) return { cmd: "xclip", args: ["-selection", "clipboard", "-in"] };
  return null;
}

function windowsUtf8ConsolePreamble() {
  return "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false;";
}

function buildClipboardImageWriteCommand(filePath, mimeOrPath = "", platform = process.platform) {
  if (platform !== "darwin") return null;
  const type = clipboardImageType(mimeOrPath || filePath);
  if (!type) return null;
  return {
    cmd: "/usr/bin/osascript",
    args: [
      "-e",
      "on run argv",
      "-e",
      "set imagePath to POSIX file (item 1 of argv)",
      "-e",
      `set the clipboard to (read imagePath as «class ${type}»)`,
      "-e",
      "end run",
      String(filePath || "")
    ]
  };
}

function normalizeClipboardText(text) {
  return String(text || "").replace(/\0+$/g, "");
}

function readSystemClipboardText(options = {}) {
  const command = buildClipboardReadCommand(options.platform, options.env);
  if (!command) return { ok: false, text: "", error: "当前平台没有可用的系统剪贴板读取命令" };
  const result = spawnSync(command.cmd, command.args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 3000,
    windowsHide: true
  });
  if (result.error) return { ok: false, text: "", error: result.error.message || String(result.error) };
  if (result.status !== 0) {
    return { ok: false, text: "", error: String(result.stderr || `exit ${result.status}`).trim() };
  }
  return { ok: true, text: normalizeClipboardText(result.stdout || "") };
}

function writeSystemClipboardText(text, options = {}) {
  const command = buildClipboardWriteCommand(options.platform, options.env);
  if (!command) return { ok: false, error: "当前平台没有可用的系统剪贴板写入命令" };
  const result = spawnSync(command.cmd, command.args, {
    input: String(text || ""),
    encoding: "utf8",
    timeout: options.timeoutMs || 3000,
    windowsHide: true
  });
  if (result.error) return { ok: false, error: result.error.message || String(result.error) };
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || `exit ${result.status}`).trim() };
  }
  return { ok: true };
}

function writeSystemClipboardImage(filePath, mimeOrPath = "", options = {}) {
  const command = buildClipboardImageWriteCommand(filePath, mimeOrPath, options.platform);
  if (!command) return { ok: false, error: "当前平台或图片格式没有可用的系统剪贴板图片写入命令" };
  const result = spawnSync(command.cmd, command.args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 5000,
    windowsHide: true
  });
  if (result.error) return { ok: false, error: result.error.message || String(result.error) };
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || `exit ${result.status}`).trim() };
  }
  return { ok: true };
}

module.exports = {
  buildClipboardReadCommand,
  buildClipboardWriteCommand,
  buildClipboardImageWriteCommand,
  clipboardImageType,
  normalizeClipboardText,
  readSystemClipboardText,
  writeSystemClipboardText,
  writeSystemClipboardImage
};
