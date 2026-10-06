@echo off
rem dskpy -- Python dsk fallback launcher (Windows). Same probe order as bin/dskpy:
rem $DSK_PY -> sibling dsk.py (installed layout) -> repo root dsk.py (source layout).
rem Kept ASCII-only: cmd.exe parses .cmd in the OEM codepage, non-ASCII garbles.
if defined DSK_PY if exist "%DSK_PY%" (
  python "%DSK_PY%" %*
  exit /b %errorlevel%
)
if exist "%~dp0dsk.py" (
  python "%~dp0dsk.py" %*
  exit /b %errorlevel%
)
if exist "%~dp0..\..\dsk.py" (
  python "%~dp0..\..\dsk.py" %*
  exit /b %errorlevel%
)
echo dskpy: cannot find dsk.py (set DSK_PY to point at it) 1>&2
exit /b 1
