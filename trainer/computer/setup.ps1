# Sets up our model on this computer: llama.cpp's llama-server (Windows, CPU only) and a starting model, in
# %USERPROFILE%\LightMoon\own-model, started with Windows. Not AppData: some programs see a private copy of it.
# It says what it will download and waits for a yes first; each download is checked against its known checksum.
# Run it with "Set up our model.cmd". -Yes skips the question, -NoStart leaves starting it for later.
param([switch]$Yes, [switch]$NoStart)
$ErrorActionPreference = 'Stop'

$Here = $PSScriptRoot
$Root = Join-Path $env:USERPROFILE 'LightMoon\own-model'
$Downloads = @(
  @{
    What = 'llama.cpp b11985 for Windows (CPU), which runs the model'
    Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b11985/llama-b11985-bin-win-cpu-x64.zip'
    File = Join-Path $Root 'llama-b11985-bin-win-cpu-x64.zip'
    Size = 24409827
    Sha256 = '1c93f23afd48f8434c4cdc4d9f0a46f47a0d98ea6b3214007cbddc10c34c0c16'
    Needed = -not (Get-ChildItem (Join-Path $Root 'llama') -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue)
  },
  @{
    What = 'Qwen3 1.7B (Q4_K_M), the starting model before any training (Apache 2.0 licence)'
    Url = 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf'
    File = Join-Path $Root 'models\Qwen3-1.7B-Q4_K_M.gguf'
    Size = 1107409472
    Sha256 = 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897'
    Needed = -not (Test-Path (Join-Path $Root 'models\Qwen3-1.7B-Q4_K_M.gguf'))
  }
)

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'models'), (Join-Path $Root 'llama') | Out-Null
$todo = @($Downloads | Where-Object { $_.Needed })
if ($todo.Count) {
  Write-Host "`nTo run our model on this computer, this downloads:`n"
  foreach ($d in $todo) {
    Write-Host ("  {0}`n    {1}`n    {2:N1} MB, from {3}`n" -f $d.What, (Split-Path $d.Url -Leaf), ($d.Size / 1MB), ([uri]$d.Url).Host)
  }
  Write-Host "into $Root"
  if (-not $Yes) { Read-Host "`nPress Enter to download, or close this window to stop" | Out-Null }
}

foreach ($d in $todo) {
  $part = "$($d.File).part"
  Write-Host "`nDownloading $(Split-Path $d.Url -Leaf)..."
  # curl.exe comes with Windows 10 and 11: a progress bar, retries, and it carries on from a broken download.
  & curl.exe -L --fail --retry 3 -C - -o $part $d.Url
  if ($LASTEXITCODE -ne 0) { throw "The download didn't finish (curl error $LASTEXITCODE). Run this again to carry on." }
  $hash = (Get-FileHash -Algorithm SHA256 $part).Hash.ToLower()
  if ((Get-Item $part).Length -ne $d.Size -or $hash -ne $d.Sha256) {
    Remove-Item $part
    throw "$(Split-Path $d.Url -Leaf) isn't the expected file (size or checksum differs), so it was deleted."
  }
  Move-Item -Force $part $d.File
}

$zip = $Downloads[0].File
if (Test-Path $zip) {
  Expand-Archive -Force -Path $zip -DestinationPath (Join-Path $Root 'llama')
  Remove-Item $zip
}

# The scripts that start and stop it, and the training notebook, next to the model.
foreach ($file in 'start.ps1', 'stop.ps1', 'Start our model.cmd', 'Stop our model.cmd') {
  Copy-Item -Force (Join-Path $Here $file) $Root
}
Copy-Item -Force (Join-Path $Here '..\lightmoon_train.ipynb') $Root

# Start it with Windows, quietly, like the LightMoon Listener.
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'LightMoon our model.lnk'))
$link.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Root\start.ps1`""
$link.WorkingDirectory = $Root
$link.WindowStyle = 7
$icon = Join-Path $env:USERPROFILE 'LightMoon\lightmoon.ico'
if (Test-Path $icon) { $link.IconLocation = $icon }
$link.Save()

Write-Host "`nSet up in $Root. It starts with Windows from now on."
if (-not $NoStart) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Root\start.ps1`"", '-Tell'
  Write-Host 'Starting it now: a message says when it is ready (the first start takes up to a minute).'
}
