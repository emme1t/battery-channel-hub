param(
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\dist\Battery-Channel-Hub-1.0.0-uninstall.exe')
)

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'windows-uninstall-launcher.cs'
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput

if (-not (Test-Path -LiteralPath $compiler)) {
    throw "未找到 C# 编译器: $compiler"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $compiler /nologo /target:winexe /optimize+ "/out:$resolvedOutput" /reference:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) {
    throw "独立卸载包编译失败，退出码: $LASTEXITCODE"
}

$artifact = Get-Item -LiteralPath $resolvedOutput
$stream = [IO.File]::OpenRead($resolvedOutput)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha256.ComputeHash($stream)
    $hashText = ([BitConverter]::ToString($hashBytes)).Replace('-', '')
}
finally {
    $sha256.Dispose()
    $stream.Dispose()
}
[pscustomobject]@{
    Path = $artifact.FullName
    Length = $artifact.Length
    SHA256 = $hashText
} | ConvertTo-Json -Compress
