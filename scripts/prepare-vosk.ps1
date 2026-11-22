$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$assetDir = Join-Path $repoRoot "release\assets"
$archive = Join-Path $assetDir "vosk-model-small-en-in-0.4.zip"
$staging = Join-Path $repoRoot "release\phase2-vosk-staging"
$destination = Join-Path $repoRoot "release\phase2-vosk-model"
$url = "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip"
$expectedSha256 = "20663DCAC4D5CB783A579C54D98339344A688E4EC6E1B4A4B059FD1235454CC7"

New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 300
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $actualSha256 = [System.BitConverter]::ToString($sha256.ComputeHash([System.IO.File]::ReadAllBytes($archive))).Replace("-", "")
} finally {
    $sha256.Dispose()
}
if ($actualSha256 -ne $expectedSha256) {
    throw "The downloaded Vosk model failed SHA-256 verification."
}

if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $staging
$modelFolder = Join-Path $staging "vosk-model-small-en-in-0.4"
if (-not (Test-Path -LiteralPath (Join-Path $modelFolder "am") -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $modelFolder "conf") -PathType Container)) {
    throw "The Vosk archive does not contain the expected model files."
}
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
Move-Item -LiteralPath $modelFolder -Destination $destination
Remove-Item -LiteralPath $staging -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "third_party\vosk\LICENSE-Apache-2.0.txt") -Destination (Join-Path $destination "LICENSE-Apache-2.0.txt")
Write-Output "Prepared verified Vosk model at $destination"
