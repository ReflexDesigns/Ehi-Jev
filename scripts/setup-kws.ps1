$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$modelsRoot = Join-Path $repoRoot 'models'
$modelName = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
$modelDir = Join-Path $modelsRoot $modelName
$archive = Join-Path $env:TEMP "$modelName.tar.bz2"
$release = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$modelName.tar.bz2"
$expectedArchiveSha256 = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a'

New-Item -ItemType Directory -Force -Path $modelsRoot | Out-Null
if (-not (Test-Path (Join-Path $modelDir 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'))) {
    Write-Host 'Scarico il modello wake-word English offline (sherpa-onnx)...'
    Invoke-WebRequest -Uri $release -OutFile $archive
    try {
        $actualArchiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualArchiveSha256 -ne $expectedArchiveSha256) {
            throw "Checksum SHA-256 del modello KWS non valido (atteso $expectedArchiveSha256, ottenuto $actualArchiveSha256)."
        }
        & tar.exe -xjf $archive -C $modelsRoot
        if ($LASTEXITCODE -ne 0) { throw 'Estrazione del modello KWS fallita.' }
    } finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
}

$tokens = Join-Path $modelDir 'tokens.txt'
$bpeModel = Join-Path $modelDir 'bpe.model'
if (-not (Test-Path $tokens) -or -not (Test-Path $bpeModel)) {
    throw "Il pacchetto modello non contiene tokens.txt o bpe.model: $modelDir"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Installa Python 3 e ripeti questo script per generare i token di «HEY JEV».' }

& $python.Source -c "import importlib.util, sys; sys.exit(0 if all(importlib.util.find_spec(name) for name in ('sherpa_onnx', 'click', 'sentencepiece', 'pypinyin')) else 1)"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Installo il solo strumento di setup per tokenizzare «HEY JEV»...'
    & $python.Source -m pip install --user sherpa-onnx==1.13.8 click==8.5.0 sentencepiece==0.2.2 pypinyin==0.55.0
    if ($LASTEXITCODE -ne 0) { throw 'Installazione del generatore token sherpa-onnx fallita.' }
}

$scriptsDir = & $python.Source -c "import sysconfig; print(sysconfig.get_path('scripts', scheme='nt_user'))"
$tokenizer = Join-Path $scriptsDir 'sherpa-onnx-cli.exe'
if (-not (Test-Path $tokenizer)) {
    $command = Get-Command sherpa-onnx-cli -ErrorAction SilentlyContinue
    if ($command) { $tokenizer = $command.Source }
    else { throw 'Non trovo sherpa-onnx-cli.exe dopo l’installazione di sherpa-onnx.' }
}

$rawKeywords = Join-Path $env:TEMP 'heyjev-keyword.txt'
$keywordFile = Join-Path $modelDir 'keywords.txt'
try {
    # "JEV" e' raro per il modello GigaSpeech: varianti foniche (anche accento italiano) con la stessa etichetta.
    # Tarate su campioni TTS: HEY JEV da solo non veniva mai rilevato.
    $variants = 'HEY JEV', 'HEY JEFF', 'A JEFF', 'HI JEFF', 'HEY GEV', 'EH JEFF', 'HEY JEFF V'
    Set-Content -LiteralPath $rawKeywords -Value ($variants | ForEach-Object { "$_ @HEY_JEV" }) -Encoding ASCII
    & $tokenizer text2token --tokens $tokens --tokens-type bpe --bpe-model $bpeModel $rawKeywords $keywordFile
    if ($LASTEXITCODE -ne 0) { throw 'Generazione keyword tokens fallita.' }
} finally {
    Remove-Item -LiteralPath $rawKeywords -Force -ErrorAction SilentlyContinue
}

Write-Host "Wake word pronta: Hey Jev (English KWS), modello in $modelDir"
Write-Host 'Ora avvia HeyJev con: npm run tauri:dev'
