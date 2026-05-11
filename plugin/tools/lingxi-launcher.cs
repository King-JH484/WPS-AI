// 灵犀AI 后台服务的零窗口启动器
//
// 为什么要这个东西:
//   计划任务 logon trigger 启 powershell.exe / cmd.exe 都会创建 console
//   窗口。-WindowStyle Hidden / ShowWindow(SW_HIDE) 兜底都会"先闪一下"或
//   "缩到任务栏"。要 100% 不闪不显,只能由一个 GUI 子系统 (winexe) 的进程
//   去 spawn node,用 CreateNoWindow 杜绝任何 console 创建。
//
// 这个文件用 .NET Framework 4 csc.exe 编译成 winexe:
//   csc.exe /nologo /target:winexe /out:lingxi-launcher.exe lingxi-launcher.cs
//
// csc.exe 路径(每台 Win7+ 自带):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
//
// 用法:
//   lingxi-launcher.exe <logPath> <staticPort> <proxyPort> <nodeExe> <scriptPath> --root <rootDir>
//
// 行为:
//   1. 不创建任何窗口(自身是 winexe 没 console)
//   2. spawn nodeExe + 其余参数,CreateNoWindow=true,继承环境变量
//      LINGXI_STATIC_PORT / PROXY_PORT
//   3. 把 node 的 stdout/stderr 异步抓到 logPath(append + flush)
//   4. 等 node 退出后才退出(task 期间 launcher 一直在,但不可见)

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

class LingxiLauncher {
    static int Main(string[] args) {
        if (args.Length < 5) {
            // 没办法弹 MessageBox(怕被杀软误报),只能写错误日志
            try {
                File.AppendAllText(
                    Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE") ?? ".", ".lingxi-ai", "launcher.log"),
                    "[launcher] 参数不够,需要: <logPath> <staticPort> <proxyPort> <exe> <args...>\r\n"
                );
            } catch { /* ignore */ }
            return 2;
        }

        string logPath    = args[0];
        string staticPort = args[1];
        string proxyPort  = args[2];
        string exePath    = args[3];
        string[] exeArgs  = args.Skip(4).ToArray();

        // 重新拼回命令行;带空格的 token 加上双引号
        var sb = new StringBuilder();
        for (int i = 0; i < exeArgs.Length; i++) {
            if (i > 0) sb.Append(' ');
            var a = exeArgs[i];
            if (a.Contains(' ') && !(a.StartsWith("\"") && a.EndsWith("\""))) {
                sb.Append('"').Append(a).Append('"');
            } else {
                sb.Append(a);
            }
        }

        var psi = new ProcessStartInfo();
        psi.FileName               = exePath;
        psi.Arguments              = sb.ToString();
        psi.CreateNoWindow         = true;
        psi.UseShellExecute        = false;
        psi.WindowStyle            = ProcessWindowStyle.Hidden;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError  = true;
        psi.WorkingDirectory       = Path.GetDirectoryName(logPath) ?? "";

        psi.EnvironmentVariables["LINGXI_STATIC_PORT"] = staticPort;
        psi.EnvironmentVariables["PROXY_PORT"]         = proxyPort;

        StreamWriter logWriter = null;
        try {
            // FileShare.Read 让别的进程也能同时看日志,FileMode.Append 追加
            var fs = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            logWriter = new StreamWriter(fs, new UTF8Encoding(false)) { AutoFlush = true };
        } catch {
            // 日志打不开就算了,反正没人能看见错误
        }

        Process proc;
        try {
            proc = Process.Start(psi);
        } catch (Exception e) {
            if (logWriter != null) {
                logWriter.WriteLine("[launcher] 起 " + exePath + " 失败: " + e.Message);
                logWriter.Close();
            }
            return 3;
        }

        if (logWriter != null) {
            proc.OutputDataReceived += (s, e) => { if (e.Data != null) logWriter.WriteLine(e.Data); };
            proc.ErrorDataReceived  += (s, e) => { if (e.Data != null) logWriter.WriteLine("[err] " + e.Data); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
        }

        proc.WaitForExit();

        if (logWriter != null) logWriter.Close();
        return proc.ExitCode;
    }
}
