// 一次性诊断件：按 bridge.ts 的 shellSpec 真实 argv 规则（windowsVerbatimArguments）
// 验证两件事——cmd 里追加哨兵 echo 能不能稳定打出来；管道/& 之后 %ERRORLEVEL% 到底反映谁。
import { spawnSync } from "node:child_process";

const run = (label, inner) => {
  const r = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", `"chcp 65001>nul&&${inner}"`],
    { shell: false, windowsVerbatimArguments: true, windowsHide: true, encoding: "utf8" }
  );
  console.log(`--- ${label}`);
  console.log(`    argv 内层: ${inner}`);
  console.log(`    status=${r.status} stdout=${JSON.stringify((r.stdout ?? "").trim())}`);
  if (r.stderr) console.log(`    stderr=${JSON.stringify(r.stderr.trim().slice(0, 120))}`);
};

run("成功命令 + 哨兵", 'node -e "console.log(1)" & echo __R1_OK__');
run("失败命令 + 哨兵（& 不判断前一条）", 'node -e "process.exit(3)" & echo __AFTER__');
run("&& 链后的 ERRORLEVEL", 'node -e "console.log(1)" && echo __RC=%ERRORLEVEL%');
run("失败后 && 链：哨兵应当不出现", 'node -e "process.exit(3)" && echo __NO__');
run("管道后的 ERRORLEVEL 只反映最后一段", 'node -e "process.exit(3)" | more & echo __RC2=%ERRORLEVEL%');
