#!/bin/bash
# Builds LightMoon Listener for Windows with the C# compiler that comes with Windows (.NET Framework 4), into
# %USERPROFILE%\LightMoon\LightMoon Listener.exe. Not AppData: some programs (the Claude desktop app among them)
# see a private copy of AppData, so a program put there would be invisible to Windows itself.
# Self-test (Windows' voice says phrases to the recognizer; results in listener.log):
#   "%USERPROFILE%\LightMoon\LightMoon Listener.exe" --self-test
# Run from Git Bash on Windows: windows/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$USERPROFILE/LightMoon"
mkdir -p "$out"
csc="$WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
speech="$WINDIR/Microsoft.NET/assembly/GAC_MSIL/System.Speech/v4.0_4.0.0.0__31bf3856ad364e35/System.Speech.dll"
"$csc" -nologo -target:winexe -optimize+ \
  -out:"$(cygpath -w "$out/LightMoon Listener.exe")" \
  -win32icon:"$(cygpath -w "$here/lightmoon.ico")" \
  -r:"$(cygpath -w "$speech")" -r:System.Windows.Forms.dll -r:System.Drawing.dll \
  "$(cygpath -w "$here/LightMoonListener.cs")"
echo "built: $out/LightMoon Listener.exe"
