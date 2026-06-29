param(
    [string]$OutputDir = "dist",
    [string]$PackageName = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionDir = Join-Path $Root "extension"
$ManifestPath = Join-Path $ExtensionDir "manifest.json"
$DistDir = Join-Path $Root $OutputDir

if (-not (Test-Path -LiteralPath $ExtensionDir -PathType Container)) {
    throw "Extension directory not found: $ExtensionDir"
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Extension manifest not found: $ManifestPath"
}

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$Version = if ($Manifest.version) { $Manifest.version } else { "dev" }

if ([string]::IsNullOrWhiteSpace($PackageName)) {
    $PackageName = "meshy-loaded-model-ripper-v$Version.zip"
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

$ZipPath = Join-Path $DistDir $PackageName
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}

$FilesToPackage = Get-ChildItem -LiteralPath $ExtensionDir -Force |
    Where-Object { $_.Name -ne ".DS_Store" }

Compress-Archive -LiteralPath $FilesToPackage.FullName -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host "Created package:"
Write-Host $ZipPath
