$ErrorActionPreference = 'Stop'
$hostName = 'com.marketplace.fipelens'
$extensionId = 'pamgljhdobicboaghhdhacicjmnoifba'
$python = (Get-Command python -ErrorAction Stop).Source
$hostScript = Join-Path $PSScriptRoot 'native_host.py'
$batPath = Join-Path $PSScriptRoot 'native_host.bat'
$manifestPath = Join-Path $PSScriptRoot 'native_host_manifest.json'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (-not (Test-Path $hostScript)) { throw "Host nao encontrado: $hostScript" }

# O Chrome no Windows nao aceita argumentos ("args") no manifesto do Native Messaging.
# Para rodar scripts Python, e necessario apontar o manifesto para um wrapper .bat/.cmd.
$batContent = "@echo off`r`n`"$python`" -u `"%~dp0native_host.py`" %*`r`n"
[System.IO.File]::WriteAllText($batPath, $batContent, [System.Text.Encoding]::ASCII)

$manifest = [ordered]@{
  name = $hostName
  description = 'Inicia o leitor headless do Marketplace FIPE Lens sob demanda'
  path = $batPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 4

[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Output "Wrapper gerado: $batPath"
Write-Output "Native host instalado para Chrome: $manifestPath"
Write-Output "ID fixo da extensao: $extensionId"
