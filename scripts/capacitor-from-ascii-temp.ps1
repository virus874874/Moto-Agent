param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CapArgs
)

$ErrorActionPreference = "Stop"

if (-not $CapArgs -or $CapArgs.Count -eq 0) {
  $CapArgs = @("sync")
}

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tempRoot = Join-Path $env:TEMP ("moto-agent-cap-" + [DateTime]::Now.ToString("yyyyMMddHHmmss"))

Push-Location $workspace
try {
  npm run build:web
}
finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $tempRoot | Out-Null

$requiredItems = @(
  "package.json",
  "package-lock.json",
  "capacitor.config.json",
  "www"
)

foreach ($item in $requiredItems) {
  $source = Join-Path $workspace $item
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $tempRoot -Recurse -Force
  }
}

foreach ($platform in @("android", "ios")) {
  $source = Join-Path $workspace $platform
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $tempRoot -Recurse -Force
  }
}

Push-Location $tempRoot
try {
  npm install
  & ".\node_modules\.bin\cap.cmd" @CapArgs
}
finally {
  Pop-Location
}

foreach ($platform in @("android", "ios")) {
  $source = Join-Path $tempRoot $platform
  $target = Join-Path $workspace $platform
  if (Test-Path -LiteralPath $source) {
    if (Test-Path -LiteralPath $target) {
      Copy-Item -LiteralPath (Join-Path $source "*") -Destination $target -Recurse -Force
    }
    else {
      Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    }
  }
}

Write-Output "Capacitor command completed through ASCII temp path: $tempRoot"
