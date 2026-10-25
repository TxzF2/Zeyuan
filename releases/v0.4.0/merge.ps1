# 泽元 v0.4.0 分卷合并
$parts = 1..6 | ForEach-Object { "zeyuan-v0.4.0-part$_.zip" }
$out = "zeyuan-portable.zip"
if (Test-Path $out) { Remove-Item $out -Force }
foreach ($p in $parts) {
  if (-not (Test-Path $p)) { Write-Host "缺少 $p" -ForegroundColor Red; exit 1 }
  $bytes = [IO.File]::ReadAllBytes($p)
  $fs = [IO.File]::Open($out, [IO.FileMode]::Append, [IO.FileAccess]::Write)
  $fs.Write($bytes, 0, $bytes.Length); $fs.Close()
  Write-Host "已合并 $p"
}
Write-Host "完成：$out" -ForegroundColor Green
Write-Host "完整 SHA256 应为：32590cb9d1f91a0219feedd3ffffe74bf3a47960e18ee04943a50eded54d2dce"
Get-FileHash $out -Algorithm SHA256
