#!/usr/bin/env node
/**
 * 根据 js/quick-actions.js + package.json 的 addonType，生成 ribbon.xml。
 *
 * 思路：
 *   - 读取当前 addonType（wps/et/wpp/pdf）
 *   - 加载 quick-actions.js 拿到该宿主的 QUICK_ACTIONS、CATEGORY_LABELS、CATEGORY_ICON
 *   - 按分类生成 <group label="写作"><button .../></group> 这样的 ribbon 结构
 *   - 每个 button 的 image 用对应分类的线性图标
 *
 * 用法：
 *   node tools/gen-ribbon.js          # 按当前 addonType 生成
 *   node tools/gen-ribbon.js wps      # 强制指定宿主
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function loadQuickActions() {
  const code = fs.readFileSync(path.resolve(root, "js/quick-actions.js"), "utf8");
  const win = {};
  new Function("window", code)(win);
  if (!win.WpsAiQuickActions) throw new Error("quick-actions.js 没有挂到 window.WpsAiQuickActions");
  return win.WpsAiQuickActions;
}

function readAddonType() {
  const cliArg = process.argv[2];
  if (cliArg && ["wps", "et", "wpp", "pdf"].includes(cliArg)) return cliArg;
  const pkg = JSON.parse(fs.readFileSync(path.resolve(root, "package.json"), "utf8"));
  return pkg.addonType || "wps";
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildRibbon(host, qa) {
  const groups = qa.getRibbonGroups(host);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<customUI xmlns="http://schemas.microsoft.com/office/2006/01/customui" onLoad="OnAddinLoad">');
  lines.push('  <ribbon startFromScratch="false">');
  lines.push('    <tabs>');
  // 所有四个宿主都把灵犀AI 插在"开始"前面。WPS Office 主程序里 wps/et/wpp/PDF 阅读模式
  // 的"开始"标签 mso id 统一是 TabHome（早期排查 PDF 不显示其实是 serve-permanent
  // 的 /pdf/* 路由 404 导致的，跟 anchor 无关）。
  lines.push('      <tab id="wpsAiTab" label="灵犀AI" 	insertBeforeMso="TabHome">');

  // 主入口 group：「打开灵犀AI」 + PPT 宿主额外的「PPT 风格」「统一风格」按钮
  lines.push('        <group id="lingxiCore" label="灵犀AI">');
  lines.push('          <button id="openWpsAiPane" label="打开灵犀AI" size="large" onAction="OnAction" getImage="GetImage" getVisible="OnGetVisible" getEnabled="OnGetEnabled"/>');
  if (host === "wpp") {
    lines.push('          <button id="lingxiStyleBtn" label="PPT 风格" size="large" onAction="OnAction" getImage="GetImage" getEnabled="OnGetEnabled"/>');
    lines.push('          <button id="lingxiUnifyBtn" label="统一风格" size="large" onAction="OnAction" getImage="GetImage" getEnabled="OnGetEnabled"/>');
    lines.push('          <button id="lingxiDeAiBtn" label="去 AI 味" size="large" onAction="OnAction" getImage="GetImage" getEnabled="OnGetEnabled"/>');
  }
  lines.push('        </group>');

  // 各分类 group
  groups.forEach((g) => {
    const groupId = `lingxi_${host}_${g.category}`;
    lines.push(`        <group id="${escapeXml(groupId)}" label="${escapeXml(g.label)}">`);
    g.actions.forEach((act) => {
      const id = `quick.${host}.${act.key}`;
      lines.push(`          <button id="${escapeXml(id)}" label="${escapeXml(act.label)}" size="normal" onAction="OnAction" getImage="GetImage" getEnabled="OnGetEnabled"/>`);
    });
    lines.push('        </group>');
  });

  lines.push('      </tab>');
  lines.push('    </tabs>');
  lines.push('  </ribbon>');
  lines.push('</customUI>');
  return lines.join("\n") + "\n";
}

function main() {
  const qa = loadQuickActions();
  const host = readAddonType();
  const xml = buildRibbon(host, qa);
  const target = path.resolve(root, "ribbon.xml");
  fs.writeFileSync(target, xml);
  const groups = qa.getRibbonGroups(host);
  const buttonCount = groups.reduce((sum, g) => sum + g.actions.length, 0);
  console.log(`[gen-ribbon] addonType=${host} → ${groups.length} 组、${buttonCount} 个快捷按钮，写入 ${target}`);
}

main();
