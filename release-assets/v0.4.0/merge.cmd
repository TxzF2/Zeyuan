@echo off
chcp 65001 >nul
echo 正在合并分卷 → zeyuan-portable.zip
if exist zeyuan-portable.zip del zeyuan-portable.zip
for %%i in (1 2 3 4 5 6) do (
  if exist zeyuan-v0.4.0-part%%i.zip (copy /b zeyuan-portable.zip+zeyuan-v0.4.0-part%%i.zip zeyuan-portable.zip >nul) else (echo 缺少 part%%i & pause & exit /b 1)
)
echo.
echo 合并完成：zeyuan-portable.zip
echo 校验：certutil -hashfile zeyuan-portable.zip SHA256
pause
