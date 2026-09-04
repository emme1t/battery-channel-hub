using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class WindowsUninstallLauncher
{
    private const string ProductName = "电池测试通道预约与使用看板";
    private const string UninstallRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    [STAThread]
    private static int Main()
    {
        string command;
        string installedExecutable;
        if (!TryReadUninstallCommand(out command, out installedExecutable))
        {
            MessageBox.Show("未检测到已安装的电池测试通道预约与使用看板。", "卸载程序", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 2;
        }

        string executable;
        string arguments;
        if (!TrySplitCommand(command, out executable, out arguments) || !File.Exists(executable))
        {
            MessageBox.Show("系统卸载项无效，请重新运行安装包后再卸载。", "卸载程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 3;
        }

        string desktopLink = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            ProductName + ".lnk");
        string backupFile = null;

        try
        {
            if (File.Exists(desktopLink) && !ShortcutTargetsFile(desktopLink, installedExecutable))
            {
                string backupDirectory = Path.Combine(Path.GetTempPath(), "BatteryChannelHubUninstall", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(backupDirectory);
                backupFile = Path.Combine(backupDirectory, ProductName + ".lnk");
                File.Copy(desktopLink, backupFile, true);
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = executable;
            startInfo.Arguments = arguments;
            startInfo.WorkingDirectory = Path.GetDirectoryName(executable);
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;

            using (Process process = Process.Start(startInfo))
            {
                process.WaitForExit();
                if (process.ExitCode != 0) return process.ExitCode;
            }

            string installDirectory = Path.GetDirectoryName(installedExecutable);
            DateTime deadline = DateTime.UtcNow.AddMinutes(2);
            while ((Directory.Exists(installDirectory) || IsProductRegistered()) && DateTime.UtcNow < deadline)
            {
                Thread.Sleep(100);
            }
            if (Directory.Exists(installDirectory) || IsProductRegistered())
            {
                MessageBox.Show("卸载进程已启动，但未在两分钟内完成。", "卸载程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 5;
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("卸载未完成：" + error.Message, "卸载程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 4;
        }
        finally
        {
            if (backupFile != null && File.Exists(backupFile))
            {
                try
                {
                    File.Copy(backupFile, desktopLink, true);
                    string backupDirectory = Path.GetDirectoryName(backupFile);
                    File.Delete(backupFile);
                    Directory.Delete(backupDirectory, false);
                    string parent = Path.GetDirectoryName(backupDirectory);
                    if (Directory.Exists(parent) && Directory.GetFileSystemEntries(parent).Length == 0)
                    {
                        Directory.Delete(parent, false);
                    }
                }
                catch
                {
                    // The unrelated shortcut backup remains in %TEMP% if restoration fails.
                }
            }
        }
    }

    private static bool TryReadUninstallCommand(out string command, out string installedExecutable)
    {
        command = null;
        installedExecutable = null;
        using (RegistryKey root = Registry.CurrentUser.OpenSubKey(UninstallRegistryPath))
        {
            if (root == null) return false;
            foreach (string childName in root.GetSubKeyNames())
            {
                using (RegistryKey child = root.OpenSubKey(childName))
                {
                    if (child == null) continue;
                    string displayName = child.GetValue("DisplayName") as string;
                    if (string.IsNullOrEmpty(displayName) || !displayName.StartsWith(ProductName, StringComparison.Ordinal)) continue;

                    command = child.GetValue("QuietUninstallString") as string;
                    if (string.IsNullOrWhiteSpace(command)) command = child.GetValue("UninstallString") as string;
                    installedExecutable = NormalizeDisplayIcon(child.GetValue("DisplayIcon") as string);
                    return !string.IsNullOrWhiteSpace(command);
                }
            }
        }
        return false;
    }

    private static bool IsProductRegistered()
    {
        string command;
        string installedExecutable;
        return TryReadUninstallCommand(out command, out installedExecutable);
    }

    private static string NormalizeDisplayIcon(string displayIcon)
    {
        if (string.IsNullOrWhiteSpace(displayIcon)) return null;
        string value = displayIcon.Trim();
        int iconIndex = value.LastIndexOf(',');
        if (iconIndex > 0) value = value.Substring(0, iconIndex);
        return value.Trim().Trim('"');
    }

    private static bool TrySplitCommand(string command, out string executable, out string arguments)
    {
        executable = null;
        arguments = string.Empty;
        if (string.IsNullOrWhiteSpace(command)) return false;

        string value = command.Trim();
        if (value[0] == '"')
        {
            int closingQuote = value.IndexOf('"', 1);
            if (closingQuote < 0) return false;
            executable = value.Substring(1, closingQuote - 1);
            arguments = value.Substring(closingQuote + 1).Trim();
            return true;
        }

        int executableEnd = value.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
        if (executableEnd < 0) return false;
        executableEnd += 4;
        executable = value.Substring(0, executableEnd).Trim();
        arguments = value.Substring(executableEnd).Trim();
        return true;
    }

    private static bool ShortcutTargetsFile(string shortcutPath, string expectedTarget)
    {
        if (string.IsNullOrWhiteSpace(expectedTarget)) return false;
        object shell = null;
        object shortcut = null;
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return false;
            shell = Activator.CreateInstance(shellType);
            shortcut = shellType.InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { shortcutPath });
            string targetPath = shortcut.GetType().InvokeMember(
                "TargetPath",
                BindingFlags.GetProperty,
                null,
                shortcut,
                null) as string;
            if (string.IsNullOrWhiteSpace(targetPath)) return false;
            return string.Equals(Path.GetFullPath(targetPath), Path.GetFullPath(expectedTarget), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
        finally
        {
            if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }
}
