问：Python 只用标准库，怎么在 Windows 上给一个命令行工具加跨进程文件锁，保证同一时刻只有一个实例在跑？要求：给出最短可用代码，并说明进程被强杀后锁会不会残留、怎么自动失效。

答：
我们需要回答用户中文问题。需要给出 Python 只用标准库，在 Windows 上给命令行工具加跨进程文件锁，保证同一时刻只有一个实例在跑。要求最短可用代码，并说明进程被强杀后锁会不会残留、怎么自动失效。

需要思考 Windows 文件锁机制。Python 标准库有 msvcrt.locking。可以在文件上锁定字节范围。Windows 上文件锁由内核管理，进程终止（包括强杀）时句柄关闭，锁自动释放。文件本身可能残留，但锁不残留。需要打开文件，锁定第一字节，若失败说明已运行。但 msvcrt.locking 行为？msvcrt.locking(fd, mode, nbytes)。模式 LK_LOCK, LK_NBLCK, LK_UNLCK 等。LK_NBLCK 非阻塞。失败抛 OSError。锁定从当前文件位置开始。通常打开文件 "a+b" 或 "r+b" 创建，seek(0)，msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)。如果文件长度 0，能锁吗？Windows 可以锁定超出 EOF 的字节？可能可以。但为了稳妥写入一个字节。需要注意文件必须至少有一个字节？msvcrt.locking 锁定 nbytes 从当前文件位置。如果文件为空，锁区域超出EOF，Windows LockFile 可以锁定超出EOF。但 msvcrt 可能没问题。不过写入一个字节更稳。可以打开 os.open(path, os.O_RDWR|os.O_CREAT), 写入 b'0' 如果空？或者用 open(path,'a+b') 并写。但多进程同时创建写入可能？写入本身不是锁。但无关，锁在之后。

最短代码：
import msvcrt, os, sys, tempfile

lock_path = os.path.join(tempfile.gettempdir(), "mycmd.lock")
f = open(lock_path, "a+b")
f.seek(0)
try:
msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
print("已经在运行")
sys.exit(1)

得到锁，继续

...

退出时释放（可选）
f.close() 释放；进程结束也会释放

但需要注意：如果文件为空，seek(0) 后锁定 1 字节。Windows 上 LockFile 可以锁定 EOF 之后。但 msvcrt.locking 可能要求文件打开可写？应该可以。要确保文件长度至少 1，可以 f.write(b'\0'); f.flush()，但多进程同时写？如果文件不存在，两个进程打开，都写？但写一个字节可能交错，但无影响。但写操作可能改变文件位置。锁定前 seek(0)。可以：
f = open(lock_path, "a+b")
if f.tell() == 0? a+b 位置在末尾？在 Windows，a+b 打开位置在末尾？写入总是在末尾。如果文件空，写 b'\0'，flush，seek(0)。但两个进程同时打开，一个写，另一个也写？锁之前写不是同步，但文件有字节即可。不过如果两个都写，文件长度可能 2，但锁第一个字节，第二个锁也锁第一个字节，冲突。没问题。

但问题要求“最短可用代码”。可能直接：
import msvcrt, sys, tempfile, os
f = open(os.path.join(tempfile.gettempdir(), "mycmd.lock"), "a+b")
f.seek(0)
try:
msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
sys.exit("已有实例在运行")

业务代码

但若文件空，锁 1 字节可能成功吗？验证。Python msvcrt.locking 调用 LockFile？在 Windows 上 LockFile 可以锁定超出当前文件末尾的区域。所以空文件也可以锁。如果失败抛 OSError。这样最短。

需要说明锁与文件句柄生命周期绑定。强杀进程（TerminateProcess、任务管理器结束）时，Windows 内核关闭所有句柄，释放字节范围锁，不会残留。锁文件本身可能留在临时目录，但里面没有有效锁，下次可以重新加锁。所以不要用“文件存在”作为锁，必须用 msvcrt.locking 这类内核锁。若想清理文件，可以在获得锁后删除？但在 Windows 上删除已打开文件可能不行，且其他进程可能已打开。可以忽略残留。或者使用临时文件带固定名字。

需要讨论跨进程文件锁在 Windows 上。msvcrt.locking 的锁是强制锁？Windows 字节范围锁是强制的，其他进程尝试读写被锁区域会失败？但这里只锁一个字节，不读写内容，仅用于互斥。其他实例尝试锁同一区域会失败。注意 msvcrt.locking 是阻塞/非阻塞？LK_NBLCK 非阻塞。成功返回 None，失败抛 OSError。锁是每个文件句柄/进程？Windows 锁与文件句柄关联，同一进程再次锁可能？不同进程互斥。同一进程内打开两个句柄，锁也可能冲突？Windows 锁与进程？LockFile 锁与文件句柄关联，同一进程不同句柄也可能冲突？但无需关心。

要提供“最短可用代码”。可以包含函数：
import msvcrt, sys, tempfile, os
lock = open(os.path.join(tempfile.gettempdir(), "mycmd.lock"), "a+b")
lock.seek(0)
try:
msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
sys.exit("另一个实例正在运行")

你的主逻辑
退出时 close 即可，锁自动释放

但需要确保 lock 变量不被垃圾回收。在模块全局保持引用。如果函数内，局部变量可能被 GC 关闭。所以保持全局。在脚本顶层没问题。若在函数内，需返回或全局。

潜在问题：打开模式 "a+b" 在 Windows 上，如果文件不存在创建。但多个进程同时打开，都成功。然后 seek(0) 锁定。如果文件为空，锁定从 0 开始 1 字节。根据 MSDN LockFile 可以锁定超出 EOF。但 msvcrt.locking 的文档：锁定文件的一部分。LK_NBLCK 非阻塞。锁定 nbytes 从当前文件位置。如果文件为空，应该可以。但为了确保，可写一个字节。最短代码可以：
f = open(lockfile, "a+b")
f.write(b'\0'); f.flush(); f.seek(0)
但写入操作在加锁前，多个进程同时写，可能都写。无妨。但 "a+b" 模式写入总是在末尾，seek 对写无影响。写入后文件位置在末尾，需 seek(0)。如果文件已有内容，写会追加，导致文件增长，每次运行都追加？不好。可以只在空时写：
f = open(lockfile, "a+b")
if os.path.getsize(lockfile) == 0:
f.write(b'\0'); f.flush()
f.seek(0)
但竞态。或者用 "r+b" 如果不存在创建。用 os.open O_RDWR|O_CREAT，然后 os.write 如果空？复杂。其实 LockFile 可以锁空文件。所以不需要写。

需要验证 msvcrt.locking 锁定空文件。我记得 Python 的 msvcrt.locking 在文件为空时锁定 1 字节会成功。在 Windows 中 LockFile 可以锁定文件末尾之后的字节，但 LockFileEx 可以。msvcrt.locking 使用 _locking，它可能调用 LockFile。应该可以。如果不行，可以写。考虑回答中提供更稳代码：先写入一个字节如果文件空。但“最短可用代码”可以权衡。可以写：
f = open(lock_path, "a+b")
f.write(b"\0") # 每次追加一个字节？不好。用 "w+b" 会截断，其他进程可能？不行。
用 os.open + os.fdopen?
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT)
f = os.fdopen(fd, "r+b", buffering=0)
if os.fstat(fd).st_size == 0:
os.write(fd, b"\0")
f.seek(0)
msvcrt.locking(fd, ...)

但最短代码可用可能不需要写。

还要注意：使用 tempfile.gettempdir() 可能不同用户/会话不同？如果命令行工具由同一用户运行，可以。若跨用户，需要公共路径如 C:\ProgramData 或程序目录。但通常同一用户。文件锁作用范围是本机？Windows 字节范围锁在本地文件系统，跨进程。如果多个用户，临时目录不同，锁文件不同，无法互斥。可以用固定路径，如 os.path.join(os.environ["PROGRAMDATA"], "mycmd.lock") 或 os.path.abspath("mycmd.lock")。用户要求“在 Windows 上给一个命令行工具加跨进程文件锁”，可以指定锁文件路径。使用 tempfile.gettempdir() 每个用户可能隔离。若要全局同一机器，可以用公共路径。但最短代码用 temp 简单。

需要说明强杀后锁会不会残留：不会。因为 Windows 文件锁是内核对象，与句柄关联，进程终止时句柄关闭，锁自动释放。锁文件可能残留，但只是普通空文件，不代表锁被占用。下次运行仍然能获取锁。不要用删除文件/创建独占文件判断，因为强杀可能残留文件导致误判。也可以说若用 os.O_CREAT|os.O_EXCL 创建文件作为锁，强杀会留下文件，需要额外 PID 检测/超时清理，不可靠。所以要用 msvcrt.locking。

需要提到锁在 close 或进程退出时释放。如果想显式释放：msvcrt.locking(fd, msvcrt.LK_UNLCK, 1); f.close()。但进程退出自动。

需要给出完整最短代码。可以包括 sys.exit 消息。示例：

lock.py

import msvcrt, os, sys, tempfile

_lock_path = os.path.join(tempfile.gettempdir(), "mycmd.lock")
_lock = open(_lock_path, "a+b")
_lock.seek(0)
try:
msvcrt.locking(_lock.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
sys.exit("另一个实例正在运行")

从这里开始是单实例保护下的主逻辑

print("running...")
input() # 模拟

不需要手动解锁；进程退出/文件关闭自动释放。若要显式：
msvcrt.locking(_lock.fileno(), msvcrt.LK_UNLCK, 1)
_lock.close()

但问题：_lock.seek(0) 在 "a+b" 打开空文件，位置可能在末尾（0）。可以。如果文件非空，位置在末尾，seek(0) 后锁第一字节。好。

但若另一个进程已经锁定第一字节，msvcrt.locking 抛 OSError，错误码可能 13？需要捕获 OSError。但注意如果文件不存在，打开 "a+b" 可能成功。如果权限问题也抛 OSError，会被误判为已有实例。可以捕获并检查 errno？在 Windows 上锁定失败 OSError: [Errno 13] Permission denied。权限问题也可能。为了简洁，可以捕获 OSError 并 exit。实际可用。

需要确保锁文件句柄不被关闭。在脚本顶层 _lock 全局。如果打包为函数，需保持引用。可以在回答中提醒。

可能问题：msvcrt.locking 的参数 nbytes 不能为 0。我们锁 1 字节。从当前位置。文件为空，锁 1 字节。如果多个进程都打开空文件，都 seek(0)，一个锁成功，另一个失败。好。

但 Windows 上文件锁是建议性还是强制性？LockFile 是强制锁。msvcrt.locking 使用 _locking，可能对文件区域加锁。其他进程如果也调用 LockFile 会冲突。即使它们不调用，锁也不阻止读写，但用于互斥足够。

需要讨论锁残留：进程被强杀后，操作系统会关闭句柄，释放锁。即使没有执行 finally/atexit。文件本身残留，但锁不残留。自动失效机制是句柄关闭。若进程崩溃、蓝屏？蓝屏后重启锁也没了。如果进程挂起但未死，锁仍持有，这是期望行为。如果程序死锁，需要人工杀。

需要提到网络文件系统？Windows 本地 NTFS 支持。如果锁文件放在 SMB/网络盘，行为可能依赖服务器，强杀后释放可能延迟/不可靠。建议放本地磁盘。临时目录通常是本地。

需要回答“最短可用代码，并说明进程被强杀后锁会不会残留、怎么自动失效。” 可以给代码和解释。

需要思考是否有更短代码：使用 msvcrt.locking 和 tempfile.NamedTemporaryFile？但 NamedTemporaryFile 在 Windows 删除有问题。直接 open。

可能代码：
import msvcrt, sys, tempfile, os
f = open(os.path.join(tempfile.gettempdir(), 'mycmd.lock'), 'a+b')
f.seek(0)
try: msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
except OSError: sys.exit('already running')

main

...
这非常短。

需要确保 f 不被 GC：在顶层是全局，没问题。若在 if name == "main": 内，f 是局部，但程序运行期间引用在局部作用域直到结束？如果之后进入主逻辑，f 仍然在局部变量中，直到函数返回。如果主逻辑是函数调用，局部 f 可能被优化？在 CPython 中局部变量在帧中保持引用，直到函数结束。所以可以。但最好全局。

可以加注释说明：不要用文件是否存在判断。锁文件可以一直存在。

可能用户要求“只用标准库”，msvcrt 是标准库但仅 Windows。tempfile/os/sys 也是。好。

需要讨论“跨进程文件锁”在 Windows 上，Python 标准库 msvcrt.locking。也可以使用 os.open 的 O_EXCL？但强杀残留，不推荐。msvcrt 是正解。

需要提到如果希望锁文件路径固定且跨用户，用类似：
lock_path = os.path.join(os.environ.get("PROGRAMDATA", tempfile.gettempdir()), "mycmd.lock")
但需要写权限。可以简略。

需要说明“锁会不会残留”：锁不会，文件会。自动失效机制：Windows 内核在进程终止时关闭所有文件句柄，关联的 LockFile 区域锁被释放。所以任务管理器结束、kill /F、崩溃都不会残留锁。唯一可能残留的是磁盘上的锁文件内容/文件本身，不影响下次加锁。若程序正常退出，close 也会释放。若使用 msvcrt.locking 后忘记 close，进程退出也释放。

需要说明“同一时刻只有一个实例在跑”：获取锁失败就退出。如果成功，执行业务。如果业务中又 fork 子进程？Windows 没有 fork。如果子进程继承句柄？默认 os.open 句柄不可继承？open 的 fd 可能不可继承？在 Windows，文件句柄默认不可继承？Python 的 open 使用 O_NOINHERIT? 不确定。但无关。若启动子进程，锁仍属于父进程，父进程结束锁释放，即使子进程还在。需要注意如果父进程启动子进程然后退出，锁会释放。但这是设计。

需要提到锁区域是第一字节，锁文件可以长期存在。不要删除锁文件，因为删除可能导致其他进程锁在旧 inode？Windows 删除已打开文件通常不行。若删除，可能新进程创建新文件，锁不同，导致互斥失效。所以不要删除锁文件。

需要提供代码中 msvcrt.LK_NBLCK 非阻塞。如果要等待，可用 LK_LOCK 阻塞，但可能一直等。这里要求保证只有一个实例，失败退出即可。

需要检查 msvcrt.locking 在 Python 3 中常量：LK_LOCK=1, LK_NBLCK=2, LK_NBRLCK=4, LK_RLCK=3, LK_UNLCK=0。对。

需要说明 f.seek(0) 重要，因为锁定从当前位置开始。打开 a+b 位置在末尾。锁定同一区域必须 seek 到同一位置。我们锁 0..1。

可能问题：如果文件为空，f.seek(0) 后锁定 1 字节。如果另一个进程也打开空文件，锁成功。但 Windows 允许锁定超出 EOF，所以可以。如果担心，可在获取锁后写入一个字节，但写入被锁区域？如果先锁再写，自己写没问题。可以：
f.seek(0)
msvcrt.locking(fd, LK_NBLCK, 1)
f.write(b'\0')? 但文件指针在0，写会覆盖，但锁区域。可以写。不过如果文件为空，写一个字节。但写操作在锁内，安全。但其他进程可能已经打开空文件并等待锁？它们失败退出。可以。代码：
f = open(path, "a+b")
f.seek(0)
msvcrt.locking(...)
f.write(b'\0') # 可选确保有字节
f.flush()
但 "a+b" 写总是在末尾，seek 对写无影响，所以会追加。如果每次运行都追加，文件增长。不好。用 "r+b" 若文件不存在创建。open(path, "a+b") 写总是末尾。可以不用写。

可以用 open(path, "r+b")，若不存在则创建：
try:
f = open(path, "r+b")
except FileNotFoundError:
f = open(path, "w+b")
但竞态：两个进程同时不存在，一个创建，另一个 FileNotFoundError 后 w+b 截断？可能导致锁文件截断，但锁区域仍在？复杂。所以 a+b 简单，不写。

需要确认 msvcrt.locking 对空文件有效。为了保险，我可以提供代码先确保文件有 1 字节，但不追加。使用 os.open 和 os.fstat：
import msvcrt, os, sys, tempfile
path = os.path.join(tempfile.gettempdir(), "mycmd.lock")
fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
f = os.fdopen(fd, "r+b", buffering=0)
if os.fstat(fd).st_size == 0:
os.write(fd, b"\0")
f.seek(0)
try:
msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
except OSError:
sys.exit("already running")

main

这段稍长但更稳。但“最短可用代码”可能用 open a+b 足够。用户要求“给出最短可用代码”，所以给最短。可以附注：若担心空文件，先写一个字节，但通常 LockFile 可锁 EOF 之后。但为了回答质量，可以给一个最短版并解释。也可以给更稳版？问题要求最短可用，给最短。需要确保代码真的可用。我想测试 msvcrt.locking 空文件。我无法实际运行 Windows，但根据知识，_locking 可以锁定超出 EOF。在 Windows 上 LockFile 函数可以锁定超出 EOF 的字节范围。msvcrt.locking 的文档说“Locks part of a file. The file must be open for writing.”? 我们打开 a+b 可写。可以。所以没问题。

需要讨论文件锁的“残留”与“自动失效”。可以分点：

锁不是靠锁文件存在，而是靠内核字节范围锁。

强杀时，Windows 关闭该进程所有句柄，msvcrt.locking 的锁随句柄释放。

因此不会死锁；锁文件可能留在 %TEMP%\mycmd.lock，但下次仍可加锁。不要删除它，也不要靠它是否存在判断。

正常退出：f.close() 或进程退出释放；显式解锁可用 LK_UNLCK。

如果程序挂起但没死，锁会一直持有，这是单实例语义。若需要超时，需要额外 PID/心跳机制，但标准库文件锁本身不提供。

需要提到“强杀”包括任务管理器结束、taskkill /F、崩溃。蓝屏/重启也释放。如果文件在本地磁盘。网络盘可能不可靠。

需要提到“同一时刻只有一个实例”范围：锁文件路径要一致。如果不同用户 temp 不同，可能不互斥。如果希望机器全局，用固定路径，例如 C:\ProgramData\mycmd\mycmd.lock，确保所有实例有权限。但代码最短用 temp。

需要可能用 os.path.join(tempfile.gettempdir(), "mycmd.lock")。注意 tempfile.gettempdir() 可能每个用户不同。如果命令行工具由同一用户运行，没问题。若需要跨用户，改路径。

需要输出格式：中文回答，代码块。开头说用 msvcrt.locking。代码：
import msvcrt, os, sys, tempfile

f = open(os.path.join(tempfile.gettempdir(), "mycmd.lock"), "a+b")
f.seek(0)
try:
msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
sys.exit("已有实例在运行")

你的主逻辑

print("只跑一个实例")

...
可选显式释放；不写也会在退出/强杀时由系统释放
msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
f.close()

需要提醒 f 要一直存活。如果在函数中，返回或赋值给全局，避免被 GC 关闭。

可以给出“更稳一点确保文件非空”版本？用户要求最短可用。可以只在说明中提。如果给两个版本可能冗长。但 desired oververbosity 5，可以给简短。

需要再考虑 msvcrt.locking 失败时，文件句柄仍打开。如果 sys.exit，进程退出关闭。好。若捕获 OSError 后不退出，可能继续？我们退出。好。

潜在错误：msvcrt.locking 在失败时，如果文件指针位置被改变？无。

需要解释为什么不用 os.open(..., O_CREAT|O_EXCL)：强杀留下文件，导致下次误判。要强调。

需要提及锁文件内容无关，可以空。锁的是字节范围，不是文件本身。多个进程锁同一字节范围互斥。

需要提到 Windows 的 msvcrt.locking 锁是强制性的吗？其实 LockFile 是强制锁，但只对锁定区域。其他进程尝试读写锁区域会失败。但这里不读写。可以简单说内核级字节范围锁。

需要提到如果使用 with open(...) 会在退出 with 后释放，不能保持。所以不要用 with 包住整个程序？可以包，但主逻辑在 with 内。最短代码没有 with。

需要检查代码中 f.seek(0) 在 a+b 模式下，文件打开位置在末尾，但 seek(0) 可以。对。

需要说明进程被强杀后锁会不会残留：不会。文件句柄由内核关闭，锁自动释放。自动失效机制：句柄关闭。若进程被挂起但未终止，锁不释放。

需要可能提到 taskkill /F 发送 TerminateProcess，不执行清理，但内核清理句柄。

需要提到锁文件可能被其他实例打开并失败，但文件句柄在退出时关闭。锁文件一直存在，不会自动删除。可以定期清理？不要。

需要回答“保证同一时刻只有一个实例在跑”。我们的代码在获取锁后执行业务。如果业务启动子进程并父进程退出，锁释放，另一个实例可能运行，但原业务子进程还在。这不是文件锁能解决的，因为锁属于父进程。若需要子进程持有，需子进程继承或自己加锁。可以忽略。

需要以中文回答。最终回答结构：

直接给最短代码。

说明关键点。

强杀残留和自动失效。

需要确保代码只用标准库。msvcrt 是 Windows 标准库。tempfile, os, sys。

可以写：

python
下载
import msvcrt, os, sys, tempfile

_lock = open(os.path.join(tempfile.gettempdir(), "mycmd.lock"), "a+b")
_lock.seek(0)
try:
    msvcrt.locking(_lock.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
    sys.exit("另一个实例正在运行")

# --- 主逻辑 ---
print("running")
# input() 等

注意 _lock 全局保持引用。如果文件为空，锁第一字节；Windows 允许锁超出 EOF。如果担心，可以在加锁后 _lock.write(b"\0"); _lock.flush()？但 a+b 写会追加。不用。

可以加一句：若你的程序在函数里，确保 _lock 不被 GC，例如 global _lock 或返回它。

强杀说明：

不会残留有效锁。Windows 内核在进程终止时关闭所有句柄，LockFile 锁随句柄销毁自动释放。

锁文件本身会残留，但只是普通文件；下次 msvcrt.locking 仍可成功。不要用“文件存在”判断单实例，也不要在退出时删除锁文件（可能造成竞态）。

正常退出也会释放；显式释放：msvcrt.locking(fd, msvcrt.LK_UNLCK, 1); f.close()。

如果进程没死只是卡住，锁会保持；这是单实例应有行为。网络盘上行为可能不同，建议本地盘。

需要提及“同一时刻只有一个实例在跑”前提：所有实例使用同一个锁文件路径。tempfile.gettempdir() 在同一用户下一致；跨用户要改到全局路径。

可以再给一个确保文件非空的版本？也许在注释中：
如果某些环境对空文件锁有疑问，可在 seek(0) 前：

python
下载
if os.path.getsize(lock_path) == 0:
    _lock.write(b"\0"); _lock.flush()

但竞态？可以。但不必须。为了简洁，不提。

需要检查“最短可用代码”是否真的最短。可以更短：
import msvcrt,sys,tempfile,os
f=open(os.path.join(tempfile.gettempdir(),'x.lock'),'a+b');f.seek(0)
try:msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
except OSError:sys.exit('busy')
但可读性差。给可读版。

需要确保 sys.exit("另一个实例正在运行") 会打印到 stderr 并退出码 1。好。

需要提到 msvcrt.LK_NBLCK 非阻塞，失败立即退出。如果想等待，用 LK_LOCK，但单实例通常失败退出。

需要讨论“强杀后锁会不会残留”更精确：如果进程被强杀，锁不会残留，因为锁与文件句柄关联。但是，如果锁文件位于网络共享，服务器可能不会立即检测到客户端断开，锁可能暂时残留，直到 TCP 超时。本地 NTFS 不会。可以加一句。

需要回答中不要包含多余。目标 oververbosity 5。可以。

需要思考是否有其他标准库方式：os.locking 不存在。msvcrt 是 Windows 专用。fcntl 不适用。portalocker 第三方。所以正确。

需要提到 msvcrt.locking 锁的是从当前文件位置开始的 nbytes。我们 seek(0) 锁第一字节。所有实例必须锁同一字节。如果文件被截断或删除，锁可能失效。不要删除。

需要提到 open 模式 a+b：追加+二进制+读写。为什么二进制？因为 msvcrt.locking 需要文件描述符，二进制避免文本缓冲？实际上 open 文本也行，但二进制更稳。a+b 确保可写，且文件不存在时创建。a 追加，写总在末尾，但我们不写。+ 允许读。可以。

需要说明 f 变量生命周期。在脚本顶层一直存在。若在 if __name__ == "__main__": 内，f 局部但直到退出。若封装函数，需保持引用。可以在代码中用 _lock 全局。

需要可能指出：在 Windows 上，msvcrt.locking 的锁不是 flock 那种整个文件锁，而是字节范围锁。我们锁 1 字节作为互斥标记。

需要最终输出。应该用中文。可以加标题。

需要确保没有声称“文件锁不会残留”而忽略锁文件。明确区分。

可以这样写：

python
下载
import msvcrt, os, sys, tempfile

lock_path = os.path.join(tempfile.gettempdir(), "mycmd.lock")
lock = open(lock_path, "a+b")
lock.seek(0)  # 所有实例都锁第 0 字节

try:
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
    sys.exit("另一个实例正在运行")

# 主逻辑...
print("running")

# 可选：正常退出时释放
# msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
# lock.close()

然后说明：

msvcrt.locking 非阻塞锁；失败抛 OSError。

锁文件路径要所有实例一致。跨用户用固定路径。

强杀：不会残留锁。Windows 内核在进程终止时关闭句柄，锁自动释放。文件可能留着，但没锁。

自动失效：句柄关闭即释放；TerminateProcess/任务管理器/崩溃都会触发内核清理。网络盘例外。

不要用 O_EXCL 创建文件，强杀会残留文件导致误判。不要删除锁文件。

需要提及“如果进程没死但卡住，锁不释放”。这是期望。

可以结束。最终回答要简洁。

用 Windows 标准库 msvcrt.locking 做内核级字节范围锁即可。最短可用代码：

python
下载
import msvcrt, os, sys, tempfile

lock_path = os.path.join(tempfile.gettempdir(), "mycmd.lock")
lock = open(lock_path, "a+b")
lock.seek(0)  # 所有实例都锁第 0 字节

try:
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
except OSError:
    sys.exit("另一个实例正在运行")

# --- 你的主逻辑 ---
print("running")

# 正常退出时 close 会自动释放；也可以显式解锁：
# msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
# lock.close()

要点：

msvcrt.LK_NBLCK 是非阻塞锁；锁不到立刻抛 OSError，这里直接退出。

所有实例必须使用同一个 lock_path。上面用当前用户临时目录；如果要跨用户互斥，改成固定全局路径，例如 C:\ProgramData\...。

lock 句柄要保持存活。脚本顶层变量没问题；如果写在函数里，要确保它不会被垃圾回收关闭。

强杀后会不会残留锁？

不会残留“有效锁”。Windows 的文件锁由内核管理，和文件句柄绑定。进程被任务管理器结束、taskkill /F、崩溃强杀时，内核会关闭该进程所有句柄，msvcrt.locking 加的锁自动释放。

但锁文件本身可能残留在 %TEMP%\mycmd.lock。它只是普通文件，不代表锁还被占用，下次运行仍能重新加锁。不要用“文件是否存在”判断单实例，也不要在退出时删除锁文件，否则可能引入竞态。

补充：如果进程没死只是卡住，锁会一直持有，这是单实例语义；如果放在网络盘/SMB 上，强杀后的释放可能依赖服务器超时，不如本地 NTFS 可靠。
