"""dsk —— 在命令行里问 DeepSeek 网页版。

    dsk "你的问题"            # 默认接在「qoder｜连续会话」里问，能不开新会话就不开
    dsk --new "问题"          # 确实要另开一条时才加；这条会命名成 qoder｜问题前 16 字
    dsk -  < question.txt     # 从 stdin 读问题
    dsk --out a.md "你的问题" # 同时把答案写进文件
    dsk chats                 # 列出侧栏里的会话标题
    dsk --chat 关键词 "问题"   # 不新建，接在含该关键词的会话后面继续问（命中多条会拒绝，要你更具体）
    dsk rm 关键词             # 删会话：默认只演练（开确认框再点取消），加 --yes 才真删；
                             # 只认「qoder｜」开头的会话，动没标记的还要再加 --any（防止误删你自己的）
    dsk --file 路径 "问题"     # 先挂附件再问，可重复多次；类型白名单见页面 input 的 accept
    dsk --no-think --no-search "问题"  # 「深度思考」「智能搜索」默认都是开的，要关哪一个就加对应开关
    dsk --no-mark "问题"       # 新建的会话默认改名成「qoder｜问题前 16 字」，加这个就不改；--mark 前缀 可换标记
    dsk up / status / down    # 只起环境 / 看状态 / 关环境并删凭据副本

等待策略：先等 30 秒；到点还在往外吐字就再加 30 秒，最多 6 段（180 秒）。
到 6 段仍没判定完成，就把已经拿到的文本返回并在日志里说明可能被截断（退出码 4）；
一个字都没拿到就直接报错退出，不会拿空答案冒充成功。

原理：把你火狐 profile 复制一份到临时目录，用 --marionette 起一个独立火狐实例，
按 Marionette 协议在网页版里发问、等生成结束、把回答读出来。不碰你正开着的火狐窗口，
不需要图形人机验证。副本里含登录凭据，所以 down 会把它删掉。
答案取的是页面自己的正文容器（最后一条 .ds-assistant-message-main-content），
思考过程在兄弟容器 .ds-think-content 里，所以不会混进答案。

命令名与帧格式（协议备忘，调过才知道的）：
  帧 = "<字节数>:<json>"；命令 = [0, id, "命令名", params]；回包 = [1, id, error, result]
  读当前地址用 WebDriver:GetCurrentURL（GetUrl / GetURL 都是 unknown command）
  提交聊天框要发 WebDriver 特殊键 RETURN（U+E007），发 \\n 不提交
"""

import configparser
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import sqlite3

CMD, RESP = 0, 1
ELID = "element-6066-11e4-a52e-4f735466cecf"
RETURN_KEY = chr(0xE007)
CHAT_URL = "https://chat.deepseek.com/"
MARK = "qoder｜"   # 我造的会话都带这个前缀，删除时用它认归属（作者 2026-10-05 定用 qoder）
OWNED = (MARK, "dsk｜")   # 旧前缀也算我的，历史遗留的会话才能照常删掉
HOME_TITLE = MARK + "连续会话"   # 默认在这条里反复问，不开新会话
PORT = 2828

APPDATA = os.environ.get("APPDATA", os.path.expanduser("~\\AppData\\Roaming"))
LOCALAPPDATA = os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local"))
WORKDIR = os.path.join(LOCALAPPDATA, "dsk-ffcopy")
FIREFOX_CANDIDATES = [
    r"C:\Program Files\Mozilla Firefox\firefox.exe",
    r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
]
# 一条助手消息的正文容器。思考过程在另一个容器 .ds-think-content 里，取正文容器
# 就天然不含它；代码块的横幅（语言名 + 复制 + 下载）在容器里面，读数前临时隐藏。
ANSWER_SEL = ".ds-assistant-message-main-content"
BANNER_SEL = ".md-code-block-banner-wrap"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def firefox_exe():
    for p in FIREFOX_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("没找到火狐，改 FIREFOX_CANDIDATES 里的路径")


def ff_available():
    try:
        s = socket.create_connection(("127.0.0.1", PORT), 1.5)
        s.close()
        return True
    except OSError:
        return False


def cookie_count_where(host_dir):
    """只数有没有 deepseek 域的 cookie，不读任何值。"""
    db = os.path.join(host_dir, "cookies.sqlite")
    if not os.path.exists(db):
        return 0
    fd, tmp = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    try:
        shutil.copyfile(db, tmp)
        conn = sqlite3.connect(tmp)
        n = conn.execute("select count(*) from moz_cookies where host like '%deepseek%'").fetchone()[0]
        conn.close()
        return n
    except Exception:
        return -1
    finally:
        os.remove(tmp)


def has_deepseek_login(profile_dir):
    n = cookie_count_where(profile_dir)
    return n if n > 0 else 0


def pick_profile():
    ini = os.path.join(APPDATA, "Mozilla", "Firefox", "profiles.ini")
    if not os.path.exists(ini):
        raise SystemExit(f"没有 profiles.ini：{ini}")
    cp = configparser.ConfigParser()
    cp.read(ini, encoding="utf-8")
    cands = []
    for sec in cp.sections():
        if not sec.startswith("Profile") or sec == "BackgroundTasksProfiles":
            continue
        path = cp[sec].get("Path", "")
        if not path:
            continue
        root = os.path.join(APPDATA, "Mozilla", "Firefox") if cp[sec].get("IsRelative") == "1" else ""
        full = os.path.normpath(os.path.join(root, path)) if root else path
        if os.path.isdir(full):
            cands.append((full, cp[sec].get("Name", ""), "Default" in cp[sec]))
    scored = [(has_deepseek_login(p), n, p, dflt) for p, n, dflt in cands]
    scored.sort(reverse=True)
    if not scored:
        raise SystemExit("没找到任何火狐 profile")
    n_cookies, name, path, dflt = scored[0]
    if n_cookies == 0:
        log("警告：所有 profile 里都没有 deepseek 的 cookie，可能没登录过")
    log(f"用 profile：{name}（deepseek cookie {n_cookies} 条）{path}")
    return path


def copy_is_good():
    """副本要真带着 deepseek 登录态才算好，光是目录存在不算。"""
    if not os.path.exists(os.path.join(WORKDIR, "cookies.sqlite")):
        return False
    return cookie_count_where(WORKDIR) > 0


def kill_instances():
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | "
          "Where-Object { $_.CommandLine -like '*dsk-ffcopy*' } | "
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }")
    out = subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps],
                         capture_output=True, text=True)
    return [ln.strip() for ln in out.stdout.splitlines() if ln.strip().isdigit()]


COPY_IGNORE = ("parent.lock", "cache2", "startupCache",
               "logins.json", "logins-backup.json", "key3.db",
               "formhistory.sqlite", "places.sqlite", "bookmarkbackups")
# key4.db 留下是必要的：cookies 要用它解密，不带就没了登录态。
# 但密码库 logins.json 与浏览历史 places.sqlite 对本次问答没用，一律不抄。


def sweep_stale():
    """上一次崩溃或被强杀留下的副本，起手先清掉，别让凭据一直躺在临时目录。"""
    if os.path.isdir(WORKDIR) and not ff_available():
        log("发现残留的旧副本（上次没收摊），先删除")
        shutil.rmtree(WORKDIR, ignore_errors=True)


def bring_up():
    sweep_stale()
    if ff_available():
        if copy_is_good():
            log("火狐 Marionette 实例已在跑")
            return
        log("端口在，但副本不干净，先关掉重来")
        kill_instances()
        time.sleep(3)
    if not copy_is_good():
        src = pick_profile()
        shutil.rmtree(WORKDIR, ignore_errors=True)
        log(f"复制 profile 到 {WORKDIR} …")
        shutil.copytree(src, WORKDIR, ignore=shutil.ignore_patterns(*COPY_IGNORE))
        if not copy_is_good():
            raise SystemExit("复制完仍然没有 deepseek 登录态，请检查火狐里的登录")
    else:
        log("副本干净，直接复用")
    lock = os.path.join(WORKDIR, "parent.lock")
    if os.path.exists(lock):
        os.remove(lock)
    exe = firefox_exe()
    log("启动独立实例 --marionette …")
    DETACHED = 0x00000008 | 0x00000200
    subprocess.Popen([exe, "-no-remote", "--profile", WORKDIR, "--marionette", "about:blank"],
                     creationflags=DETACHED, close_fds=True)
    for _ in range(30):
        if ff_available():
            log("2828 已就绪")
            return
        time.sleep(1)
    raise SystemExit("等了 30 秒，2828 还没起来")


def tear_down():
    killed = kill_instances()
    shutil.rmtree(WORKDIR, ignore_errors=True)
    log(f"已关实例 {killed}，副本已删：{not os.path.isdir(WORKDIR)}")


class Marionette:
    def __init__(self, timeout=30.0):
        self.s = socket.create_connection(("127.0.0.1", PORT), timeout)
        self.s.settimeout(timeout)
        self._id = 0
        self._read()

    def _read(self):
        head = b""
        while b":" not in head:
            chunk = self.s.recv(1)
            if not chunk:
                raise ConnectionError("Marionette 连接被关")
            head += chunk
        n = int(head[:-1].decode())
        body = b""
        while len(body) < n:
            chunk = self.s.recv(n - len(body))
            if not chunk:
                break
            body += chunk
        return json.loads(body.decode())

    def do(self, name, params=None):
        self._id += 1
        mine = self._id
        data = json.dumps([CMD, mine, name, params or {}], separators=(",", ":")).encode()
        self.s.sendall(str(len(data)).encode() + b":" + data)
        while True:
            reply = self._read()
            if isinstance(reply, list) and len(reply) >= 4 and reply[0] == RESP and reply[1] == mine:
                err, result = reply[2], reply[3]
                if err:
                    raise RuntimeError(f"{name}: {err.get('message', err)}")
                return result

    def js(self, script, args=None):
        out = self.do("WebDriver:ExecuteScript",
                      {"script": script, "args": args or [], "timeout": 30})
        return out.get("value") if isinstance(out, dict) else out

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


TOGGLE_FINDER = """
const want = arguments[0];
const leaf = [...document.querySelectorAll('*')].filter(e => !e.children.length)
  .find(e => (e.textContent || '').trim() === want);
if (!leaf) return null;
let el = leaf;
for (let i = 0; i < 6 && el; i++) {
  if (el.getAttribute && el.hasAttribute('aria-pressed')) return el;
  el = el.parentElement;
}
return null;
"""

def set_toggle(m, label, want):
    """把「深度思考」「智能搜索」这类开关调到 want；已经是目标值就不动。
    设完就留着：作者 2026-10-05 定这两个默认要开，拨回原样反而会把你
    留在上一次的状态上。"""
    found = m.js(TOGGLE_FINDER, [label])
    eid = found.get(ELID) if isinstance(found, dict) else None
    if not eid:
        log(f"  警告：没找到开关「{label}」，保持原样")
        return None
    now = m.do("WebDriver:GetElementAttribute", {"id": eid, "name": "aria-pressed"}).get("value")
    if now == str(want).lower():
        return now
    m.do("WebDriver:ElementClick", {"id": eid})
    time.sleep(1.5)
    after = m.do("WebDriver:GetElementAttribute",
                 {"id": eid, "name": "aria-pressed"}).get("value")
    log(f"  开关「{label}」{now} -> {after}（要 {want}）")
    return after


READ_LAST_ANSWER = """
const sel = arguments[0], banner = arguments[1];
const els = [...document.querySelectorAll(sel)];
const busy = !!document.querySelector('[class*=stop-btn],[aria-label*=停止]');
let last = '';
if (els.length) {
  const node = els[els.length - 1];
  const bars = [...node.querySelectorAll(banner)];
  bars.forEach(b => b.style.setProperty('display', 'none', 'important'));
  last = node.innerText || '';
  bars.forEach(b => b.style.removeProperty('display'));
}
return JSON.stringify({count: els.length, busy: busy, last: last});
"""


def read_last_answer(m):
    """页面上最后一条助手消息的读数：{count, busy, last}。

    last 是渲染后的 innerText，所以保留 markdown 的换行；标准库离线跑不了这段 JS，
    它只在真页面上由 tools/probe_answer_container.py 量。
    """
    raw = m.js(READ_LAST_ANSWER, [ANSWER_SEL, BANNER_SEL])
    return json.loads(raw) if raw else {}


def answer_state(d, count_before, last_before):
    """把一次读数分类成 (状态, 文本)。

    no-container  页面上一个正文容器都没有：全新会话还没出答案，或改版让类名失效
    pending       这一问还没落地——条数没涨、最后一条还停留在提交前那一条
    generating    新答案正在往外长字
    ready         新答案停笔了
    """
    if not d.get("count"):
        return "no-container", ""
    text = d.get("last") or ""
    if not text.strip():
        return "pending", ""
    if d["count"] <= count_before and text == last_before:
        return "pending", ""
    return ("generating" if d.get("busy") else "ready"), text


RENAME_XP = "//div[contains(@class,'ds-dropdown-menu-option')][.//*[normalize-space(text())='重命名']]"


def current_title(m, chat_id):
    for r in conv_anchors(m):
        if r["id"] == chat_id:
            return r["title"]
    return None


SET_TITLE_JS = """
const old = arguments[0], title = arguments[1];
const pool = [...document.querySelectorAll('input')];
const i = pool.find(x => (x.value || '') === old)
       || pool.find(x => x === document.activeElement && x.tagName === 'INPUT')
       || pool[0];
if (!i) return 'no-input';
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(i, title);
i.dispatchEvent(new Event('input', {bubbles: true}));
for (const type of ['keydown', 'keyup']) {
  i.dispatchEvent(new KeyboardEvent(type, {key: 'Enter', code: 'Enter',
    keyCode: 13, which: 13, bubbles: true, cancelable: true}));
}
return 'set:' + i.value;
"""


def rename(m, chat_id, new_title):
    """把会话改名，用来标记"这条是 dsk 发的"。改的是标题，不动发给模型的文字。
    菜单项必须真点（合成事件不生效），但进到编辑框之后不能再用元素句柄——
    React 每次重渲染都会让句柄失效，所以填值这一步整体交给 JS。"""
    if m.js(OPEN_MENU_BY_ID, [chat_id]) != "menu-open":
        log("  改名失败：打不开行菜单")
        return False
    time.sleep(1.2)
    eid = find_element(m, "xpath", RENAME_XP)
    if not eid:
        log("  改名失败：菜单里没有「重命名」")
        return False
    m.do("WebDriver:ElementClick", {"id": eid})
    time.sleep(1.5)
    old = current_title(m, chat_id)
    result = m.js(SET_TITLE_JS, [old, new_title])
    if not str(result).startswith("set:"):
        log(f"  改名失败：{result}")
        return False
    time.sleep(2.5)
    after = current_title(m, chat_id)
    if after == new_title:
        log(f"  已改名：{old} → {after}")
        return True
    if after and after.startswith(MARK):
        # DeepSeek 会截断过长的标题，带上前缀就算标记成功
        log(f"  已改名（标题被平台截短）：{after}")
        return True
    log(f"  改名没生效：现在叫「{after}」")
    return False


def wait_for_answer(read_once, segment=30, max_segments=6, tick=3, min_wait=12, stable_need=3):
    """read_once() 返回 {'state':…, 'text':…}。
    先给一整个 segment；到点还在长字就续下一段，最多 max_segments 段。
    判定"写完"= 文本连续 stable_need 次采样不变（且至少等过 min_wait 秒）。"""
    last, stable, waited, state = "", 0, 0, ""
    deadline, segments = segment, 1
    while True:
        time.sleep(tick)
        waited += tick
        d = read_once()
        txt = (d.get("text") or "").strip()
        state = d.get("state")
        if txt and txt == last and waited >= min_wait:
            stable += 1
            if stable >= stable_need:
                break
        else:
            stable = 0
        last = txt
        if waited >= deadline:
            if segments >= max_segments:
                log(f"{waited} 秒仍没判定完成，先返回已拿到的 {len(last)} 字（可能被截断）")
                break
            segments += 1
            deadline += segment
            log(f"到 {waited} 秒还在输出，再加 {segment} 秒（第 {segments} 段）")
    log(f"生成等待 {waited} 秒，共 {segments} 段；收尾状态 {state}；答案 {len(last)} 字")
    return last, segments, (stable < stable_need)


def ask(question, chat=None, think=True, search=True, files=None,
        segment=30, max_segments=6, mark=MARK, mode="reuse"):
    m = Marionette()
    m.do("WebDriver:NewSession", {"capabilities": {
        "alwaysMatch": {"browserName": "firefox", "pageLoadStrategy": "eager"},
        "firstMatch": [{}]}})
    handles = m.do("WebDriver:GetWindowHandles")
    m.do("WebDriver:SwitchToWindow", {"handle": handles[-1]})
    m.do("Marionette:SetContext", {"value": "content"})

    m.do("WebDriver:Navigate", {"url": CHAT_URL})
    time.sleep(6)
    rows = conv_anchors(m)
    target = None
    if chat:
        hits = [r for r in rows if chat in r["title"]]
        if not hits:
            raise SystemExit(f"侧栏里没有含「{chat}」的会话。可选的有：\n  " + "\n  ".join(r["title"] for r in rows[:20]))
        if len(hits) > 1:
            raise SystemExit("「{k}」命中 {n} 条，说得更具体些：\n  {c}".format(
                k=chat, n=len(hits), c="\n  ".join(r["title"] for r in hits)))
        target = hits[0]
        log(f"进会话「{target['title']}」")
    elif mode == "reuse":
        home = [r for r in rows if HOME_TITLE in r["title"]]
        spare = [r for r in rows if r["title"].startswith(OWNED)]
        if home:
            target = home[0]
            log(f"复用连续会话「{target['title']}」")
        elif spare:
            target = spare[0]
            log(f"没有「{HOME_TITLE}」，先复用现成的 dsk 会话「{target['title']}」")
    if target:
        m.do("WebDriver:Navigate", {"url": "https://chat.deepseek.com/a/chat/s/{i}".format(i=target["id"])})
        time.sleep(4)
        created = False
    else:
        log("开新对话：" + str(m.js("""
          const hit = [...document.querySelectorAll('button,[role=button],a,div,span,li')]
            .filter(e => !e.children.length)
            .find(e => (e.textContent || '').trim().startsWith('开启新对话'));
          if (hit) { hit.click(); return 'clicked'; }
          return 'not-found';
        """)))
        time.sleep(3)
        created = True
    set_toggle(m, "深度思考", think)
    set_toggle(m, "智能搜索", search)
    for f in files or []:
        attach(m, f)
    try:
        try:
            found = m.do("WebDriver:FindElement", {"using": "css selector", "value": "textarea"})
        except RuntimeError as exc:
            where = m.js("return location.href;")
            what = m.js("return (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0,160);")
            raise SystemExit(f"找不到输入框（{exc}）。当前页 {where}；页面开头：{what}")
        eid = found.get(ELID) if isinstance(found, dict) else None
        if not eid and isinstance(found, dict) and isinstance(found.get("value"), dict):
            eid = found["value"].get(ELID)
        if not eid:
            raise SystemExit("没拿到输入框句柄")
        m.do("WebDriver:ElementClick", {"id": eid})
        m.do("WebDriver:ElementSendKeys", {"id": eid, "text": question})
        typed = m.js("const t=document.querySelector('textarea');return t?t.value:'';") or ""
        if typed != question:
            raise SystemExit(f"输入框内容与问题不一致（读到 {len(typed)} 字），已中止")
        # 上一条还在生成时，回车会被页面吃掉，而且新回合的正文容器排不到最后一条位置，
        # 所以先把这个前提验掉，别等满段数才发现问的根本不是这一条。
        d0 = read_last_answer(m)
        if d0.get("busy"):
            raise SystemExit("上一条还在生成（页面有「停止」按钮），这条会被吃掉。"
                             "等它答完再问，或 dsk down 后重来")
        count_before, last_before = d0.get("count", 0), d0.get("last") or ""
        log("已填入并回读一致，提交中…")
        m.do("WebDriver:ElementSendKeys", {"id": eid, "text": RETURN_KEY})

        def read():
            state, text = answer_state(read_last_answer(m), count_before, last_before)
            return {"state": state, "text": text}

        last, segments, truncated = wait_for_answer(read, segment, max_segments)
        if not last:
            where = m.js("return location.href;")
            d = read_last_answer(m)
            raise SystemExit(
                "没拿到答案（%d 秒内最后一条正文容器要么没出现、要么一直是空的）。\n"
                "  停在 %s\n  正文容器 %s 条（提交前 %s 条），生成中=%s\n"
                "  两种可能：上一条把这条吞了；或页面改版让 %s 失效"
                % (segment * max_segments, where, d.get("count", 0), count_before,
                   d.get("busy"), ANSWER_SEL))
        if created and mark:
            href = m.js("return location.href;") or ""
            cid = href.split("/a/chat/s/")[-1] if "/a/chat/s/" in href else None
            try:
                if cid:
                    head = (question.splitlines()[0] if question.strip() else "提问")[:16]
                    title = HOME_TITLE if mode == "reuse" else mark + head
                    rename(m, cid, title)
                else:
                    log(f"  没从地址里看到会话 id（当前 {href}），跳过改名")
            except Exception as exc:
                log(f"  改名这步出错，答案不受影响：{exc}")
        return last, truncated
    except SystemExit:
        raise
    except Exception as exc:
        where = m.js("return location.href;")
        head = m.js("return (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0,200);")
        raise SystemExit(f"这一问没走完：{exc}\n  停在 {where}\n  页面开头：{head}")
    finally:
        m.close()


ANCHORS = """
return JSON.stringify([...document.querySelectorAll('a[href*="/a/chat/s/"]')].map(a => {
  const r = a.getBoundingClientRect();
  return {title: (a.textContent || '').trim().slice(0, 60),
          id: (a.getAttribute('href') || '').split('/').pop(),
          top: Math.round(r.top)};
}).filter(x => x.title && x.id));
"""

OPEN_MENU_BY_ID = """
const id = arguments[0];
const a = [...document.querySelectorAll('a[href*="/a/chat/s/"]')].find(e => (e.getAttribute('href') || '').includes(id));
if (!a) return 'no-anchor';
const b = a.querySelector('[role=button]');
if (!b) return 'no-button';
b.click();
return 'menu-open';
"""

DELETE_XP = "//div[contains(@class,'ds-dropdown-menu-option')][.//*[normalize-space(text())='删除']]"
BTN = "//*[self::button or @role='button' or contains(@class,'ds-button')]"
CONFIRM_XP = f"{BTN}[normalize-space(text())='删除该对话' or .//*[normalize-space(text())='删除该对话']]"
CANCEL_XP = f"{BTN}[normalize-space(text())='取消' or .//*[normalize-space(text())='取消']]"


def conv_anchors(m):
    raw = m.js(ANCHORS)
    return json.loads(raw) if raw else []


def find_element(m, using, value):
    found = m.do("WebDriver:FindElement", {"using": using, "value": value})
    if isinstance(found, dict):
        if ELID in found:
            return found[ELID]
        v = found.get("value")
        if isinstance(v, dict):
            return v.get(ELID)
    return None


def delete_conversation(m, keyword, apply=False, allow_unmarked=False):
    """先按会话 id 或标题关键词找会话；命中唯一一条才动手。默认只演练。
    没带 qoder｜ 标记的会话一律不删，除非显式给 allow_unmarked——
    2026-10-05 就因为用正文关键词判断归属，误删了作者自己的两条会话。"""
    all_rows = conv_anchors(m)
    if len(keyword) >= 32 and "-" in keyword:
        hits = [r for r in all_rows if r["id"] == keyword]
    else:
        hits = [r for r in all_rows if keyword in r["title"]]
    if hits and not allow_unmarked and not any(
            p in r["title"] for r in hits for p in OWNED):
        raise SystemExit(
            "这几条没有「{m}」前缀，不敢删（万一是你自己的会话）：\n  {c}\n"
            "确认要删再加 --any".format(m=MARK, c="\n  ".join(r["title"] for r in hits)))
    if not hits:
        names = "\n  ".join(r["title"] for r in all_rows[:20])
        raise SystemExit(f"没有标题含「{keyword}」的会话。侧栏现有：\n  {names}")
    if len(hits) > 1:
        raise SystemExit("「{k}」命中 {n} 条，太宽泛不敢删：\n  {c}".format(
            k=keyword, n=len(hits),
            c="\n  ".join(f"{r['title']}  id={r['id']}" for r in hits)))
    row = hits[0]
    print(f"目标会话：{row['title']}  id={row['id']}")

    state = m.js(OPEN_MENU_BY_ID, [row["id"]])
    if state != "menu-open":
        raise SystemExit(f"打不开这条会话的行菜单：{state}")
    time.sleep(1.5)
    eid = find_element(m, "xpath", DELETE_XP)
    if not eid:
        raise SystemExit("菜单里没有「删除」项")
    m.do("WebDriver:ElementClick", {"id": eid})
    time.sleep(2)

    if not apply:
        cancel = find_element(m, "xpath", CANCEL_XP)
        if cancel:
            m.do("WebDriver:ElementClick", {"id": cancel})
        print("演练模式：已打开确认框又点了「取消」，会话没删。要真删加 --yes")
        return False

    confirm = find_element(m, "xpath", CONFIRM_XP)
    if not confirm:
        raise SystemExit("确认框里没找到「删除该对话」按钮，已停手，请人工看一眼")
    m.do("WebDriver:ElementClick", {"id": confirm})
    time.sleep(3)
    gone = not [r for r in conv_anchors(m) if r["id"] == row["id"]]
    print(f"已删除：{row['title']}（复查侧栏{'已无此条' if gone else '仍能看到，可能列表没刷新'}）")
    return gone


UNHIDE_FILE_INPUT = """
const i = document.querySelector('input[type=file]');
if (!i) return 'no-input';
let el = i;
for (let k = 0; k < 5 && el; k++) {
  el.removeAttribute('hidden');
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') el.style.setProperty('display', 'block', 'important');
  el = el.parentElement;
}
i.style.setProperty('position', 'fixed', 'important');
i.style.setProperty('left', '20px', 'important');
i.style.setProperty('top', '200px', 'important');
i.style.setProperty('width', '260px', 'important');
i.style.setProperty('height', '32px', 'important');
i.style.setProperty('opacity', '1', 'important');
i.style.setProperty('z-index', '99999', 'important');
i.style.removeProperty('display');
return 'ok';
"""


def attach(m, path):
    """把本地文件喂给页面的 input[type=file]。它平时 display:none，
    Marionette 不肯往不可见元素上打字，所以先显形再喂路径。"""
    if not os.path.exists(path):
        raise SystemExit(f"文件不存在：{path}")
    if m.js(UNHIDE_FILE_INPUT) != "ok":
        raise SystemExit("页面里没有 input[type=file]")
    time.sleep(1)
    found = m.do("WebDriver:FindElement", {"using": "css selector", "value": "input[type=file]"})
    eid = (found.get("value") or {}).get(ELID) if isinstance(found, dict) else None
    if not eid:
        raise SystemExit("拿不到文件输入框句柄")
    m.do("WebDriver:ElementSendKeys", {"id": eid, "text": os.path.abspath(path)})
    name = os.path.basename(path)
    for _ in range(10):
        time.sleep(2)
        if name in (m.js("return document.body.innerText;") or ""):
            log(f"  已挂上附件：{name}")
            return True
    raise SystemExit(f"喂了路径但页面没出现文件名：{name}")


def chat_session():
    m = Marionette()
    m.do("WebDriver:NewSession", {"capabilities": {
        "alwaysMatch": {"browserName": "firefox", "pageLoadStrategy": "eager"},
        "firstMatch": [{}]}})
    handles = m.do("WebDriver:GetWindowHandles")
    m.do("WebDriver:SwitchToWindow", {"handle": handles[-1]})
    m.do("Marionette:SetContext", {"value": "content"})
    m.do("WebDriver:Navigate", {"url": CHAT_URL})
    time.sleep(7)
    return m


def list_chats():
    with chat_session() as m:
        return [r["title"] for r in conv_anchors(m)]


def read_stdin():
    """Windows 下 sys.stdin 默认按本地代码页解码，中文会变成代理码，
    后面一打印就 UnicodeEncodeError。所以直接读字节、按 UTF-8 解，
    解不动再退回本地编码。"""
    raw = sys.stdin.buffer.read() if hasattr(sys.stdin, "buffer") else b""
    for enc in ("utf-8", "gbk", "cp936"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "up":
        bring_up()
        return 0
    if argv[0] == "down":
        tear_down()
        return 0
    if argv[0] == "status":
        print(f"Marionette 端口 {PORT}: {'在听' if ff_available() else '没起'}")
        print(f"凭据副本 {WORKDIR}: {'在' if os.path.isdir(WORKDIR) else '不在'}")
        print(f"火狐: {firefox_exe()}")
        return 0
    if argv[0] == "chats":
        bring_up()
        for t in list_chats():
            print(t)
        return 0
    if argv[0] == "rm":
        apply = "--yes" in argv[1:]
        allow_unmarked = "--any" in argv[1:]
        words = [a for a in argv[1:] if a not in ("--yes", "--any")]
        if not words:
            raise SystemExit("用法：dsk rm 标题关键词 [--yes]（不加 --yes 只演练；没 qoder｜ 标记的还要 --any）")
        bring_up()
        delete_conversation(chat_session(), words[0], apply=apply,
                            allow_unmarked=allow_unmarked)
        return 0

    out_file = None
    chat = None
    think = True    # 默认把两个开关都打开；--no-think / --no-search 才关
    search = True
    files = []
    mark = MARK
    mode = "reuse"
    rest = []
    args = list(argv)
    while args:
        a = args[0]
        if a == "--out":
            out_file, args = args[1], args[2:]
        elif a == "--chat":
            chat, args = args[1], args[2:]
        elif a == "--think":
            think, args = True, args[1:]
        elif a == "--no-think":
            think, args = False, args[1:]
        elif a == "--search":
            search, args = True, args[1:]
        elif a == "--no-search":
            search, args = False, args[1:]
        elif a == "--file":
            files.append(args[1])
            args = args[2:]
        elif a == "--no-mark":
            mark, args = None, args[1:]
        elif a == "--mark":
            mark, args = args[1], args[2:]
        elif a == "--new":
            mode, args = "new", args[1:]
        else:
            rest.append(a)
            args = args[1:]
    question = read_stdin().strip() if rest and rest[0] == "-" else " ".join(rest).strip()
    if not question:
        raise SystemExit("问题为空")

    bring_up()
    log("问：" + question[:120].replace("\n", " "))
    answer, truncated = ask(question, chat=chat, think=think, search=search,
                            files=files, mark=mark, mode=mode)
    if out_file:
        with open(out_file, "w", encoding="utf-8") as fh:
            fh.write(f"问：{question}\n\n答：\n{answer}\n")
        log(f"已写 {out_file}")
    print(answer)
    if truncated:
        log("答案可能被截断（段数用完还没判定完成）——退出码 4")
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
