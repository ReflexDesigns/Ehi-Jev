$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$modelsRoot = Join-Path $repoRoot 'models'
$modelName = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
$modelDir = Join-Path $modelsRoot $modelName
$archive = Join-Path $env:TEMP "$modelName.tar.bz2"
$release = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$modelName.tar.bz2"

New-Item -ItemType Directory -Force -Path $modelsRoot | Out-Null
if (-not (Test-Path (Join-Path $modelDir 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'))) {
    Write-Host 'Scarico il modello wake-word English offline (sherpa-onnx)...'
    Invoke-WebRequest -Uri $release -OutFile $archive
    try {
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

& $python.Source -m pip show sherpa-onnx *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Installo il solo strumento di setup per tokenizzare «HEY JEV»...'
    & $python.Source -m pip install --user sherpa-onnx
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
    Set-Content -LiteralPath $rawKeywords -Value 'HEY JEV' -Encoding ASCII
    & $tokenizer text2token --tokens $tokens --tokens-type bpe --bpe-model $bpeModel $rawKeywords $keywordFile
    if ($LASTEXITCODE -ne 0) { throw 'Generazione keyword tokens fallita.' }
} finally {
    Remove-Item -LiteralPath $rawKeywords -Force -ErrorAction SilentlyContinue
}

Write-Host "Wake word pronta: Hey Jev (English KWS), modello in $modelDir"
Write-Host 'Ora avvia HeyJev con: npm run tauri:dev'
