# 残留进程清扫（env.ts 调用）：只杀两类目标，严禁按裸字符串全局匹配——
# 否则会误杀命令行里恰好带着 profile 名的 shell/编辑器（2026-10-06 实弹教训：杀了祖先进程）。
param([string]$ProfileName, [int]$ExceptPid)
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'firefox.exe' -and $_.CommandLine -like "*$ProfileName*") -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*keeper.ts*')
} | ForEach-Object {
  if ($_.ProcessId -ne $ExceptPid) {
    "$($_.ProcessId)|$($_.Name)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
