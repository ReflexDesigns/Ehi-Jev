$ErrorActionPreference = 'Stop'
# Con la progress bar Invoke-WebRequest in PowerShell 5.1 e' lentissimo sui file grandi.
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$whisperRoot = Join-Path $repoRoot 'models\whisper'
$binaryDir = Join-Path $whisperRoot 'bin'
$modelPath = Join-Path $whisperRoot 'ggml-tiny.bin'
$modelDownload = Join-Path $whisperRoot 'ggml-tiny.bin.download'
$archive = Join-Path $env:TEMP 'heyjev-whisper-bin-b5130.zip'
$extractDir = Join-Path $env:TEMP 'heyjev-whisper-bin-b5130'
$binaryUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip'
$modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin?download=true'
$expectedBinaryZipSha256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
$expectedModelSha256 = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
$whisperVersion = 'ggml-org/whisper.cpp b5130 cli+dll'
$versionFile = Join-Path $binaryDir '.heyjev-whisper-version'

New-Item -ItemType Directory -Force -Path $whisperRoot | Out-Null

if (Test-Path -LiteralPath $modelPath) {
    $actualModelSha256 = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualModelSha256 -ne $expectedModelSha256) {
        throw "Il modello Whisper esistente non corrisponde al checksum previsto ($actualModelSha256). Non l'ho sovrascritto: controlla $modelPath."
    }
} else {
    Write-Host 'Scarico il modello multilingue Whisper tiny (circa 75 MiB)...'
    try {
        Invoke-WebRequest -Uri $modelUrl -OutFile $modelDownload
        $actualModelSha256 = (Get-FileHash -LiteralPath $modelDownload -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualModelSha256 -ne $expectedModelSha256) {
            throw "Checksum SHA-256 del modello Whisper non valido (atteso $expectedModelSha256, ottenuto $actualModelSha256)."
        }
        Move-Item -LiteralPath $modelDownload -Destination $modelPath
    } finally {
        Remove-Item -LiteralPath $modelDownload -Force -ErrorAction SilentlyContinue
    }
}

$installed = (Test-Path -LiteralPath (Join-Path $binaryDir 'whisper-cli.exe')) -and
    (Test-Path -LiteralPath $versionFile) -and
    ((Get-Content -LiteralPath $versionFile -Raw).Trim() -eq $whisperVersion)
if (-not $installed) {
    Write-Host 'Scarico whisper.cpp CLI ufficiale per Windows x64 (CPU)...'
    # Cartella bin vecchia/sporca (es. esempi e test dell'archivio): si riparte da zero.
    if (Test-Path -LiteralPath $binaryDir) { Remove-Item -LiteralPath $binaryDir -Recurse -Force }
    if (Test-Path -LiteralPath $extractDir) {
        Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
    try {
        Invoke-WebRequest -Uri $binaryUrl -OutFile $archive
        $actualBinaryZipSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualBinaryZipSha256 -ne $expectedBinaryZipSha256) {
            throw "Checksum dell'archivio whisper.cpp non valido (atteso $expectedBinaryZipSha256, ottenuto $actualBinaryZipSha256)."
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
        $cli = Get-ChildItem -LiteralPath $extractDir -Filter 'whisper-cli.exe' -File -Recurse | Select-Object -First 1
        if (-not $cli) { throw 'L''archivio ufficiale non contiene whisper-cli.exe.' }

        New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null
        Copy-Item -LiteralPath $cli.FullName -Destination $binaryDir -Force
        # Solo le librerie che servono a whisper-cli (niente SDL2/llama/parakeet degli esempi).
        Get-ChildItem -LiteralPath $cli.DirectoryName -File |
            Where-Object { $_.Name -eq 'whisper.dll' -or $_.Name -like 'ggml*.dll' } |
            Copy-Item -Destination $binaryDir -Force
        if (-not (Test-Path -LiteralPath (Join-Path $binaryDir 'whisper-cli.exe'))) {
            throw 'Copia di whisper-cli.exe o delle sue librerie runtime fallita.'
        }
        Set-Content -LiteralPath $versionFile -Value $whisperVersion -Encoding ASCII
    } finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Whisper pronto: modello multilingue tiny e CLI x64 in $whisperRoot"
