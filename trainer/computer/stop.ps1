# Stops our model (the llama-server started from this folder). It starts again with Windows, or with
# "Start our model".
$server = Join-Path $PSScriptRoot 'llama'
Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$server\*" } | Stop-Process -Force
