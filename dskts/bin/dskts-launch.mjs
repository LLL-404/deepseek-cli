// dskts 入口转发桩（ASCII 路径，UTF-8 内容——Node 按 UTF-8 读 JS，中文路径安全）。
// 存在理由：cmd.exe 按 OEM 代码页解析 .cmd，
// 中文路径写进去会乱码，所以 PATH 上的桩只含 ASCII 内容。
//
// 真身定位顺序（不写死任何绝对路径，克隆到哪儿都能用）：
//   1. 环境变量 DSKTS_REAL —— 桩被装到别处（如 ~/.qoder-cn/bin/）时用它指路
//   2. 相对自身 ../src/dskts.ts —— 桩留在 dskts/bin/ 里时直接可用
//   3. 都没有 → 报错退出，不静默失败
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.DSKTS_REAL,
  path.join(here, "..", "src", "dskts.ts"),
].filter((p) => !!p);

const real = candidates.find((p) => existsSync(p));
if (!real) {
  console.error(
    "dskts 转发桩：找不到真身 src/dskts.ts。\n" +
    "  修法一：设 DSKTS_REAL 指向它\n" +
    "  修法二：直接用 node <仓库>/dskts/src/dskts.ts"
  );
  process.exit(1);
}
await import(pathToFileURL(real).href);
