# 残留进程清扫（env.ts 调用）：只杀两类目标，严禁按裸字符串全局匹配——
# 否则会误杀命令行里恰好带着 profile 名的 shell/编辑器（2026-10-06 实弹教训：杀了祖先进程）。
# keeper 认 `--dsk-keeper` 进程标记（S4）：explorer 代启与常规 spawn 两条路都会带；
# 不再用 `*keeper.ts*` 子串匹配（会误杀其它项目里恰好同名的文件）。旧版 keeper
# （没带标记）清扫不到，关掉它的窗口或手工杀一次即可——本版之后全部带标记。
param([string]$ProfileName, [int]$ExceptPid)
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'firefox.exe' -and $_.CommandLine -like "*$ProfileName*") -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*--dsk-keeper*')
} | ForEach-Object {
  if ($_.ProcessId -ne $ExceptPid) {
    "$($_.ProcessId)|$($_.Name)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
