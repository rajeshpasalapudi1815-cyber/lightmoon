# Starts our model: llama-server on 127.0.0.1:8080 (OpenAI-compatible; only this computer can reach it) with the
# newest model the trainer made (models\lightmoon-YYYY-MM-DD...gguf), or else the starting model. A newer
# lightmoon-*.gguf in Downloads is moved into models first. Any copy already running is stopped, and the new one
# runs at below-normal priority so the computer stays responsive. -Tell shows a message once it's ready.
param([switch]$Tell)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Models = Join-Path $Here 'models'

function Say($text) {
  Add-Content -Path (Join-Path $Here 'start.log') -Value "$(Get-Date -Format s) $text"
  if ($Tell) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($text, 'LightMoon: our model') | Out-Null
  }
}

try {
  $downloaded = Get-ChildItem (Join-Path $env:USERPROFILE 'Downloads') -Filter 'lightmoon-*.gguf' -ErrorAction SilentlyContinue
  foreach ($file in $downloaded) {
    if (-not (Test-Path (Join-Path $Models $file.Name))) { Move-Item $file.FullName $Models }
  }

  $server = Get-ChildItem (Join-Path $Here 'llama') -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $server) { throw 'llama-server.exe is missing. Run "Set up our model" first.' }
  # The trainer puts the date in the name, so the last by name is the newest.
  $model = Get-ChildItem $Models -Filter 'lightmoon-*.gguf' | Sort-Object Name | Select-Object -Last 1
  if (-not $model) { $model = Get-ChildItem $Models -Filter '*.gguf' | Sort-Object LastWriteTime | Select-Object -Last 1 }
  if (-not $model) { throw 'There is no model in the models folder. Run "Set up our model" first.' }
  $name = $model.Name -replace '\.gguf$', ''

  Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $server.FullName } | Stop-Process -Force
  Start-Sleep -Milliseconds 500

  # --jinja: the model's own chat template, which also turns its tool calls into OpenAI-style ones.
  # -c 12288: LightMoon's instructions and tools are long; -np 1: one request at a time, keeping memory low.
  $arguments = @('-m', "`"$($model.FullName)`"", '--alias', $name, '--host', '127.0.0.1', '--port', '8080', '--jinja', '-c', '12288', '-np', '1')
  $process = Start-Process -FilePath $server.FullName -ArgumentList $arguments -WorkingDirectory $Here -NoNewWindow -PassThru `
    -RedirectStandardError (Join-Path $Here 'server.log') -RedirectStandardOutput (Join-Path $Here 'server-output.log')
  $process.PriorityClass = 'BelowNormal'

  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) { throw "llama-server stopped straight away. The end of server.log in $Here says why." }
    try {
      if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8080/health').StatusCode -eq 200) {
        Say "Our model is running: $name. LightMoon on this computer starts comparing with it within a few minutes."
        exit 0
      }
    } catch {
      # still loading
    }
  }
  throw "llama-server didn't get ready within two minutes. The end of server.log in $Here says why."
} catch {
  Say "Our model couldn't start: $($_.Exception.Message)"
  exit 1
}
