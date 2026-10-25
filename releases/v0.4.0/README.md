# 泽元 v0.4.0 分卷下载

完整包大小 **149.35 MB**，因网络原因拆成 **6 卷**（每卷 ≤25MB）。

## 合并（Windows，二选一）

**方式 A：双击 merge.cmd**
把本文件夹里所有 `part*.zip` 与 `merge.cmd` 放在同一目录，双击 `merge.cmd`，得到 `zeyuan-portable.zip`。

**方式 B：命令行**
```cmd
copy /b zeyuan-v0.4.0-part1.zip + zeyuan-v0.4.0-part2.zip + ... + zeyuan-v0.4.0-part6.zip zeyuan-portable.zip
```

**方式 C：PowerShell**
```powershell
Get-ChildItem "zeyuan-v0.4.0-part*.zip" | Sort-Object Name | ForEach-Object {
  $fs = [IO.File]::Open("zeyuan-portable.zip","Append","Write")
  $b = [IO.File]::ReadAllBytes($_.FullName); $fs.Write($b,0,$b.Length); $fs.Close()
}
```

## 校验
合并后 `zeyuan-portable.zip` 的 SHA256 应为：

```
32590cb9d1f91a0219feedd3ffffe74bf3a47960e18ee04943a50eded54d2dce
```

对比命令：`certutil -hashfile zeyuan-portable.zip SHA256` 或 `Get-FileHash zeyuan-portable.zip`。

## 分卷清单

| 文件 | 大小 | SHA256 |
|---|---|---|
| zeyuan-v0.4.0-part1.zip | 25.00 MB | `831e7a8f36ea4ce7…` |
| zeyuan-v0.4.0-part2.zip | 25.00 MB | `11a19bbc74390978…` |
| zeyuan-v0.4.0-part3.zip | 25.00 MB | `78a89b1b24160f3f…` |
| zeyuan-v0.4.0-part4.zip | 25.00 MB | `4f086ac7632ba8c8…` |
| zeyuan-v0.4.0-part5.zip | 25.00 MB | `be37c954c9192389…` |
| zeyuan-v0.4.0-part6.zip | 24.35 MB | `5077a0490933d307…` |

> 解压合并后的 zip，双击 `zeyuan-installer.exe` 安装。
