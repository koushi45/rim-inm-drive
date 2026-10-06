Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NativeInput {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$cmd = Get-Process cmd -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like "*cmd.exe*" } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1

if (-not $cmd) {
  Write-Host "No visible cmd.exe window found."
  exit 1
}

[NativeInput]::ShowWindow($cmd.MainWindowHandle, 9) | Out-Null
[NativeInput]::SetForegroundWindow($cmd.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500

$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys("{ESC}")
Start-Sleep -Milliseconds 300
$shell.SendKeys("y{ENTER}")
Start-Sleep -Milliseconds 300
$shell.SendKeys("b{ENTER}")

Write-Host "Sent Esc, y+Enter, and b+Enter to cmd window PID $($cmd.Id)."
