@echo off
chcp 65001 >nul
setlocal
REM 这是一个备份脚本，用于本地打包，需要在本目录下下载Python 3.9及以上嵌入式版本并通过pip安装相关库，重命名为runtime
REM 以本脚本所在目录为 packaging，项目根目录为其上一级（与 setup.iss 的 ..\ 引用一致）
set "PACKAGING=%~dp0"
set "PACKAGING=%PACKAGING:~0,-1%"
pushd "%PACKAGING%\.."
set "ROOT=%CD%"
popd

echo 项目根目录: %ROOT%
echo 打包脚本目录: %PACKAGING%
echo.

echo [1/5] 清理缓存...
for /d /r "%ROOT%" %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d" >nul 2>&1
del /s /q "%ROOT%\*.pyc" >nul 2>&1
del /s /q "%ROOT%\*.pyo" >nul 2>&1
for /d /r "%ROOT%\runtime" %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d" >nul 2>&1
del /s /q "%ROOT%\runtime\*.pyc" >nul 2>&1
if exist "%ROOT%\runtime\pip-cache" rd /s /q "%ROOT%\runtime\pip-cache"

echo [2/5] 生成图标资源文件...
copy "%ROOT%\app\static\favicon.ico" "%PACKAGING%\logo.ico" /Y >nul
echo 1 ICON "logo.ico" > "%PACKAGING%\icon.rc"
pushd "%PACKAGING%"
windres icon.rc -o icon.o
echo [3/5] 编译托盘启动器...
gcc launcher.c icon.o -o FluxNote.exe -mwindows -lshell32
del icon.rc
del icon.o
copy FluxNote.exe "%ROOT%\FluxNote.exe" /Y
copy logo.ico "%ROOT%\logo.ico" /Y
popd

echo [4/5] 修改核心程序图标和版本信息...
if not exist "%PACKAGING%\rcedit.exe" (
    echo 下载 rcedit...
    curl -L -o "%PACKAGING%\rcedit.exe" https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe
)
"%PACKAGING%\rcedit.exe" "%PACKAGING%\runtime\FluxNoteCore.exe" --set-version-string "FileDescription" "FluxNote 网络核心服务" --set-version-string "ProductName" "FluxNote" --set-version-string "CompanyName" "Soulxyz" --set-icon "%ROOT%\logo.ico"

echo [5/5] 打包 runtime.zip...
if exist "%PACKAGING%\\runtime.zip" del /q "%ROOT%\runtime.zip"
tar -a -c -f "%PACKAGING%\\runtime.zip" -C "%ROOT%" runtime

echo.
echo 完成，输出位于项目根目录，可用 Inno Setup 编译 packaging\setup.iss。
pause
