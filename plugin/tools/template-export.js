"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function validatePotx(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 64) throw new Error("POTX 临时文件为空或过小");
  const buffer = fs.readFileSync(filePath);
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error("POTX 不是 ZIP/OOXML 文件");
  const binary = buffer.toString("latin1");
  for (const required of ["[Content_Types].xml", "ppt/presentation.xml"]) {
    if (!binary.includes(required)) throw new Error(`POTX 缺少 ${required}`);
  }
  return { size: stat.size };
}

function createTemplateExportManager({ ttlMs = 10 * 60 * 1000 } = {}) {
  const pending = new Map();

  function prepare({ finalPath, overwrite = false } = {}) {
    const target = path.resolve(String(finalPath || ""));
    if (!/\.potx$/i.test(target)) throw new Error("模板输出路径必须以 .potx 结尾");
    const directory = path.dirname(target);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error("模板输出目录不存在");
    if (fs.existsSync(target) && !overwrite) throw new Error("目标文件已存在；如需覆盖请显式设置 overwrite=true");
    const token = crypto.randomBytes(16).toString("hex");
    const tempPath = path.join(directory, `.${path.basename(target)}.anthony-${token}.tmp.potx`);
    pending.set(token, { token, tempPath, finalPath: target, overwrite: overwrite === true, createdAt: Date.now() });
    return { token, tempPath, finalPath: target };
  }

  function getRecord(token) {
    const record = pending.get(String(token || ""));
    if (!record) throw new Error("未知或已失效的模板导出事务");
    if (Date.now() - record.createdAt > ttlMs) {
      pending.delete(record.token);
      try { fs.unlinkSync(record.tempPath); } catch (error) {}
      throw new Error("模板导出事务已过期");
    }
    return record;
  }

  function cleanup({ token } = {}) {
    const record = getRecord(token);
    try { if (fs.existsSync(record.tempPath)) fs.unlinkSync(record.tempPath); } catch (error) {}
    pending.delete(record.token);
    return { cleaned: true };
  }

  function finalize({ token } = {}) {
    const record = getRecord(token);
    const validated = validatePotx(record.tempPath);
    let backupPath = null;
    try {
      if (fs.existsSync(record.finalPath)) {
        if (!record.overwrite) throw new Error("目标文件在导出期间被创建，拒绝覆盖");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        backupPath = `${record.finalPath}.${stamp}.bak`;
        fs.renameSync(record.finalPath, backupPath);
      }
      fs.copyFileSync(record.tempPath, record.finalPath, fs.constants.COPYFILE_EXCL);
      validatePotx(record.finalPath);
      fs.unlinkSync(record.tempPath);
      pending.delete(record.token);
      return { path: record.finalPath, backupPath, size: validated.size };
    } catch (error) {
      try { if (fs.existsSync(record.finalPath)) fs.unlinkSync(record.finalPath); } catch (cleanupError) {}
      if (backupPath) {
        try { fs.renameSync(backupPath, record.finalPath); } catch (restoreError) {}
      }
      throw error;
    }
  }

  return { prepare, finalize, cleanup };
}

module.exports = { validatePotx, createTemplateExportManager };
