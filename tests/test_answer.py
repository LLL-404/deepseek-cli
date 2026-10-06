"""dsk.py 里「新答案到底落地没有」的离线测试。只用标准库 unittest，不联网、不起浏览器。

跑：python tests/test_answer.py   （在本目录的上一层跑，或直接在 tests 里跑）

这里测两块：answer_state()（7 项）和 wait_for_answer()（7 项，注入假 read_once、
tick 调到毫秒级）。页面读数（.ds-assistant-message-main-content 那个 JS）没法离线
跑——标准库执行不了页面 JS，那部分靠 tools/probe_answer_container.py 在真页面上量，
两者不能互相替代。

为什么不用 importlib 载入 dsk.py：它写 __pycache__，而失效判据是「源码 mtime 秒数 +
字节数」。2026-10-05 变异测试实测到一次假绿——把 ("generating" if busy else "ready")
两个词对调，字节数不变，一秒内写回原文件，子进程仍 import 到旧字节码，测试报
FAILED (failures=3)；删掉 __pycache__ 才恢复。python -B 挡不住，它只禁止写字节码，
照样读旧的。compile+exec 直接吃源码文本，不过缓存。
"""
import io
import os
import types
import unittest

DSK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dsk.py")
dsk = types.ModuleType("dsk")
dsk.__file__ = DSK
exec(compile(io.open(DSK, encoding="utf-8").read(), DSK, "exec"), dsk.__dict__)

PREV = "上一条的答案正文"
NEW = "这一问的新答案正文"


def reading(count, busy, last):
    return {"count": count, "busy": busy, "last": last}


class AnswerState(unittest.TestCase):
    """answer_state(读数, 提交前条数, 提交前最后一条文本) -> (状态, 文本)"""

    def test_unchanged_last_answer_is_pending(self):
        """条数没涨、最后一条还停留在提交前那条：不能算落地。

        旧的"数问题文本出现次数"实现就是在这里出事的——侧栏把历史问题标题也
        列在 body 里，次数被算多，切片切到末尾，返回空答案还退出码 4。
        """
        self.assertEqual(dsk.answer_state(reading(3, False, PREV), 3, PREV),
                         ("pending", ""))

    def test_count_growth_lands_even_if_text_looks_familiar(self):
        st, text = dsk.answer_state(reading(4, True, NEW), 3, PREV)
        self.assertEqual((st, text), ("generating", NEW))

    def test_same_count_but_different_text_lands(self):
        """早先的回合被虚拟列表卸掉时条数不变，靠文本变化认新回合。"""
        st, text = dsk.answer_state(reading(3, False, NEW), 3, PREV)
        self.assertEqual((st, text), ("ready", NEW))

    def test_empty_container_text_is_pending(self):
        st, text = dsk.answer_state(reading(4, True, "   "), 3, PREV)
        self.assertEqual((st, text), ("pending", ""))

    def test_no_container_at_all_is_reported_as_such(self):
        """改版让类名失效，或全新会话还没出过答案：调用方要能区分"没落地"和"没这个东西"。"""
        st, text = dsk.answer_state(reading(0, False, ""), 0, "")
        self.assertEqual((st, text), ("no-container", ""))

    def test_busy_flag_decides_generating_vs_ready(self):
        self.assertEqual(dsk.answer_state(reading(2, True, NEW), 1, PREV)[0], "generating")
        self.assertEqual(dsk.answer_state(reading(2, False, NEW), 1, PREV)[0], "ready")

    def test_missing_keys_do_not_raise(self):
        st, text = dsk.answer_state({}, 0, "")
        self.assertEqual((st, text), ("no-container", ""))


class WaitForAnswer(unittest.TestCase):
    """wait_for_answer() 的离线测试：注入假 read_once，tick 调到毫秒级。

    问题提交之后的全部判断都在这个函数里——假完成、读数抖动、封顶截断——
    它接受 read_once 参数，恰好能整体离线测，不用起浏览器。
    """

    @staticmethod
    def scripted(script):
        it = iter({"state": s, "text": t} for s, t in script)
        return lambda: next(it)

    def wait(self, read_once, **kw):
        kw.setdefault("tick", 0.01)
        kw.setdefault("min_wait", 0)
        kw.setdefault("stable_need", 3)
        kw.setdefault("segment", 10)
        return dsk.wait_for_answer(read_once, **kw)

    def test_stable_text_with_stop_button_still_up_is_not_done(self):
        """文本几拍没动但页面还挂着「停止」：不许当写完。

        旧实现只看文本稳定——生成中途一停顿（网络、思考与作答之间）超过
        三拍，就把半截答案当成品、退出码 0。这正是「答案残缺但退出码 0」。
        """
        last, _, truncated = self.wait(self.scripted([
            ("generating", "半截"), ("generating", "半截"), ("generating", "半截"),
            ("generating", "半截"),
            ("ready", "完整答案"), ("ready", "完整答案"), ("ready", "完整答案"),
            ("ready", "完整答案"),
        ]))
        self.assertEqual((last, truncated), ("完整答案", False))

    def test_stop_button_clearing_with_same_text_confirms_right_away(self):
        """「停止」消失而文本没再变：下一拍就确认，不加多余等待。"""
        last, _, truncated = self.wait(self.scripted([
            ("generating", "答案"), ("generating", "答案"), ("generating", "答案"),
            ("ready", "答案"), ("ready", "答案"),
        ]))
        self.assertEqual((last, truncated), ("答案", False))

    def test_stable_and_not_busy_confirms(self):
        last, _, truncated = self.wait(self.scripted([
            ("generating", "abc"), ("ready", "abc"), ("ready", "abc"), ("ready", "abc"),
        ]))
        self.assertEqual((last, truncated), ("abc", False))

    def test_one_off_read_failures_are_skipped(self):
        """问题已提交后读数抖两拍：跳过重读，不该把整问赔进去。"""
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] in (2, 3):
                raise RuntimeError("读数抖了")
            return {"state": "ready", "text": "答案"}

        last, _, truncated = self.wait(flaky)
        self.assertEqual((last, truncated), ("答案", False))

    def test_reads_dying_for_good_with_text_returns_truncated(self):
        seen = {"n": 0}

        def dies_after_first():
            seen["n"] += 1
            if seen["n"] == 1:
                return {"state": "generating", "text": "半截"}
            raise RuntimeError("连接断了")

        last, _, truncated = self.wait(dies_after_first)
        self.assertEqual((last, truncated), ("半截", True))

    def test_reads_dying_for_good_with_no_text_raises(self):
        def always_dead():
            raise RuntimeError("起手就挂")

        with self.assertRaises(RuntimeError):
            self.wait(always_dead)

    def test_cap_while_still_generating_is_truncated_even_if_text_froze(self):
        """到段数上限时页面还在生成：就算文本已经稳了几拍也算截断。

        旧实现拿 stable < stable_need 当截断标志——文本先稳下来、随后一直
        挂着「停止」到封顶的场合，stable 早就攒够了，会错报成完整答案。
        """
        last, _, truncated = self.wait(
            lambda: {"state": "generating", "text": "卡住的半截"},
            stable_need=2, segment=0.03, max_segments=1)
        self.assertEqual((last, truncated), ("卡住的半截", True))


if __name__ == "__main__":
    unittest.main()
