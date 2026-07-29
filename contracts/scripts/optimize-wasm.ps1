# Optimize WASM binaries with wasm-opt after cargo build.
# Requires: cargo install wasm-opt  (or download binaryen)
#
# Usage: .\optimize-wasm.ps1 [-TargetDir <path>] [-OptLevel <flag>]

param(
    [string]$TargetDir = "target\wasm32-unknown-unknown\release",
    [string]$OptLevel = "-Oz"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wasm-opt -ErrorAction SilentlyContinue)) {
    Write-Error "wasm-opt not found. Install via: cargo install wasm-opt"
    exit 1
}

Write-Host "Optimizing WASM binaries in $TargetDir with $OptLevel ..."

$count = 0
Get-ChildItem -Path $TargetDir -Filter "*.wasm" -File | ForEach-Object {
    $before = $_.Length
    & wasm-opt $OptLevel --output $_.FullName $_.FullName
    $_.Refresh()
    $after = $_.Length
    $saved = $before - $after
    $pct = if ($before -gt 0) { [math]::Round($saved * 100 / $before) } else { 0 }
    Write-Host "  $($_.Name): $before -> $after bytes (saved $saved, $pct%)"
    $count++
}

if ($count -eq 0) {
    Write-Warning "No .wasm files found in $TargetDir"
} else {
    Write-Host "Done. Optimized $count file(s)."
}
