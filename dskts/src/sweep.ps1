# 残留进程清扫（env.ts 调用）：只杀两类目标，严禁按裸字符串全局匹配——
# 否则会误杀命令行里恰好带着 profile 名的 shell/编辑器（2026-10-06 实弹教训：杀了祖先进程）。
# keeper 认 `--dsk-keeper` 进程标记（S4）：explorer 代启与常规 spawn 两条路都会带；
# 不再用 `*keeper.ts*` 子串匹配（会误杀其它项目里恰好同名的文件）。旧版 keeper
# （没带标记）清扫不到，关掉它的窗口或手工杀一次即可——本版之后全部带标记。
#
# 本文件必须是「UTF-8 带 BOM」。2026-10-09 实弹教训：没有 BOM 时 Windows PowerShell 5.1
# 按本机 ANSI 代码页（GBK）读它，中文注释的字节序列会把下面 param() 那一行吞进注释里——
# 脚本照样跑，但三个参数一个都没绑上：$ProfileName 成了空，`-like "*"` 于是匹配**机器上
# 每一个 firefox.exe**（包括你自己正在用的窗口），$ExceptPid 成了 0 连豁免也失效，
# 传开关也没用。症状是 keeper 在自己的调用里被杀、日志一行错误都没有。
# 所以：参数没绑上就报错退出，绝不带着空匹配继续跑。
param([string]$ProfileName, [int]$ExceptPid)
if (-not $ProfileName -or $ExceptPid -le 0) {
  Write-Error "sweep.ps1 参数没绑上（ProfileName=[$ProfileName] ExceptPid=[$ExceptPid]）——多半是文件被当成 ANSI 读了，需要 UTF-8 BOM"
  exit 2
}
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'firefox.exe' -and $_.CommandLine -like "*$ProfileName*") -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*--dsk-keeper*')
} | ForEach-Object {
  if ($_.ProcessId -ne $ExceptPid) {
    "$($_.ProcessId)|$($_.Name)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
