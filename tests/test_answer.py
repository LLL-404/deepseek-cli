"""dsk.py 里「新答案到底落地没有」的离线测试。只用标准库 unittest，不联网、不起浏览器。

跑：python tests/test_answer.py   （在本目录的上一层跑，或直接在 tests 里跑）

这里只测纯函数 answer_state()。页面读数（.ds-assistant-message-main-content 那个
JS）没法离线跑——标准库执行不了页面 JS，那部分靠 tools/probe_answer_container.py
在真页面上量，两者不能互相替代。

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


if __name__ == "__main__":
    unittest.main()
