"""在真页面上量 dsk 的答案读数（联网工具，不进自动测试；跑之前先 dsk up 或让它自己起）。

    python tools/probe_answer_container.py            # 只报数
    python tools/probe_answer_container.py --out F    # 顺便把当前最后一条答案正文存成 F

报的三件事：
  1. 页面里 .ds-assistant-message-main-content 有几条（每条对应一次助手回答）；
  2. 隐藏 .md-code-block-banner-wrap 前后各多少字，横幅行（语言名/复制/下载）是否真没了；
  3. 同一份读数连取两次是否一致——answer_state 靠"文本变没变"认新回合，读数必须确定。

思考块在 .ds-think-content，不在正文容器里，所以这里应当恒报 has-thinking-marker=False；
它一旦变 True，就是页面改版了，dsk 的取词逻辑要重摸。
"""
import io
import json
import os
import sys
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
DSK = os.path.join(os.path.dirname(HERE), "dsk.py")
dsk = types.ModuleType("dsk")
dsk.__file__ = DSK
exec(compile(io.open(DSK, encoding="utf-8").read(), DSK, "exec"), dsk.__dict__)

READ_TWICE = """
const sel = arguments[0], banner = arguments[1];
const els = [...document.querySelectorAll(sel)];
const busy = !!document.querySelector('[class*=stop-btn],[aria-label*=停止]');
const think = [...document.querySelectorAll('.ds-think-content')];
function grab(strip) {
  if (!els.length) return '';
  const node = els[els.length - 1];
  const bars = [...node.querySelectorAll(banner)];
  if (strip) bars.forEach(b => b.style.setProperty('display', 'none', 'important'));
  const t = node.innerText || '';
  if (strip) bars.forEach(b => b.style.removeProperty('display'));
  return t;
}
return JSON.stringify({count: els.length, busy: busy, thinkCount: think.length,
                       bars: els.length ? els[els.length - 1]
                         .querySelectorAll(banner).length : 0,
                       raw: grab(false), stripped: grab(true)});
"""

MARKERS = ("已思考", "我应该", "用户要求", "深度思考", "内容由 AI")


def main():
    out = None
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    dsk.bring_up()
    m = dsk.chat_session()
    rows = dsk.conv_anchors(m)
    if not rows:
        print("侧栏没有任何会话锚点：页面可能改版了")
        return 1
    home = [r for r in rows if dsk.HOME_TITLE in r["title"]] or rows[:1]
    m.do("WebDriver:Navigate",
         {"url": "https://chat.deepseek.com/a/chat/s/%s" % home[0]["id"]})
    time.sleep(6)
    d = json.loads(m.js(READ_TWICE, [dsk.ANSWER_SEL, dsk.BANNER_SEL]))
    print("会话：%s（id=%s）" % (home[0]["title"], home[0]["id"]))
    print("正文容器 %d 条，思考容器 %d 条，最后一条里有 %d 个代码块横幅，生成中=%s"
          % (d["count"], d["thinkCount"], d["bars"], d["busy"]))
    print("隐藏横幅前 %d 字 -> 之后 %d 字" % (len(d["raw"]), len(d["stripped"])))
    st, text = dsk.answer_state({"count": d["count"], "busy": d["busy"],
                                 "last": d["stripped"]}, d["count"] - 1, "")
    print("answer_state(把最后一条当作新回合) -> %s, %d 字" % (st, len(text)))
    for marker in MARKERS:
        if marker in d["stripped"]:
            print("警告：答案正文里出现了「%s」——页面结构变了，取词逻辑要重摸" % marker)
            break
    else:
        print("答案正文里没有任何思考/页脚标记（has-thinking-marker=False）")
    if out:
        with io.open(out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(d["stripped"])
        print("已存 " + out)
    m.close()
    return 0


if __name__ == "__main__":
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    raise SystemExit(main())
