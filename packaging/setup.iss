#ifndef AppVer
  #define AppVer "dev"
#endif

[Setup]
AppName=FluxNote
AppVersion={#AppVer}
AppPublisher=Soulxyz
DefaultDirName={localappdata}\Programs\FluxNote
DefaultGroupName=FluxNote
OutputDir=..\Output
OutputBaseFilename=FluxNote_Setup_v{#AppVer}
Compression=lzma2/fast
SolidCompression=no
RestartIfNeededByRun=no
SetupIconFile=..\logo.ico
UninstallDisplayIcon={app}\FluxNote.exe
DisableProgramGroupPage=yes
; 禁用官方的"驱动器校验拦截"，改用 [Code] 手动软读取旧路径，避免旧驱动器不存在时弹窗报错
UsePreviousAppDir=no

[Languages]
Name: "chinesesimp"; MessagesFile: "..\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startmenu"; Description: "创建开始菜单快捷方式"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\FluxNote.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\server.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\VERSION"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\runtime.zip"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\FluxNote"; Filename: "{app}\FluxNote.exe"; Tasks: startmenu
Name: "{group}\{cm:UninstallProgram,FluxNote}"; Filename: "{uninstallexe}"; Tasks: startmenu
Name: "{autodesktop}\FluxNote"; Filename: "{app}\FluxNote.exe"; Tasks: desktopicon

[Run]
; 删除了原来的 tar 解压命令，将其移交到底层 Code 控制以接管进度条
Filename: "{app}\FluxNote.exe"; Description: "运行 FluxNote"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: files; Name: "{app}\.gitattributes"
Type: files; Name: "{app}\.gitignore"
Type: files; Name: "{app}\README.md"
Type: dirifempty; Name: "{app}"

[Code]
function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

function TerminateProcess(hProcess: THandle; uExitCode: UINT): BOOL;
  external 'TerminateProcess@kernel32.dll stdcall';

function CloseHandle(hObject: THandle): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';

const
  PROCESS_TERMINATE = $0001;
  SYNCHRONIZE       = $00100000;
  WAIT_OBJECT_0     = $00000000;

function OpenProcess(dwDesiredAccess: LongWord; bInheritHandle: LongBool; dwProcessId: LongWord): THandle;
  external 'OpenProcess@kernel32.dll stdcall';

function WaitForSingleObject(hHandle: THandle; dwMilliseconds: LongWord): LongWord;
  external 'WaitForSingleObject@kernel32.dll stdcall';

var
  DeleteUserData: Boolean;
  DirHintLabel: TNewStaticText; // 用于在选择目录界面显示的文字标签
  DriveWarnLabel: TNewStaticText; // 驱动器离线时显示的橙色警告标签
  DriveWarnText: String;          // 在 GetCustomDefaultDir 里写入，InitializeWizard 里读取
  InstallLogFile: String;         // 安装日志文件路径
  TarExtractOK: Boolean;          // 解压是否成功完成（阶段1结果）

// 写入安装日志（追加模式，带时间戳）
procedure Log2(const Msg: String);
var
  Timestamp: String;
begin
  if InstallLogFile = '' then Exit;
  Timestamp := GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':');
  SaveStringToFile(InstallLogFile, '[' + Timestamp + '] ' + Msg + #13#10, True);
end;

// 执行命令并将 stdout+stderr 捕获写入日志
// 仅用于同步调用（ewWaitUntilTerminated），异步启动请直接用 Exec
procedure ExecLog(const Desc, Exe, Params, WorkDir: String; out ExitCode: Integer);
var
  OutFile: String;
  OutText: AnsiString;
  Lines: String;
begin
  OutFile := ExpandConstant('{tmp}\execlog_out.txt');
  DeleteFile(OutFile);
  // 用 cmd /C 包一层，将 stdout 和 stderr 都重定向到临时文件
  Exec('cmd.exe', '/C ""' + Exe + '" ' + Params + ' > "' + OutFile + '" 2>&1"',
    WorkDir, SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Log2(Desc + ' → 退出码：' + IntToStr(ExitCode));
  if FileExists(OutFile) then
  begin
    if LoadStringFromFile(OutFile, OutText) then
    begin
      Lines := Trim(String(OutText));
      if Lines <> '' then
        Log2('  输出：' + Lines);
    end;
    DeleteFile(OutFile);
  end;
end;

// 智能读取上一次安装路径：驱动器存在则沿用旧路径，否则降级为默认路径
// 配合 UsePreviousAppDir=no 使用，避免旧驱动器（如已拔出的U盘）引发弹窗中止
function GetCustomDefaultDir(Param: String): String;
var
  OldDir, Drive: String;
  RegKey: String;
begin
  RegKey := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\FluxNote_is1';
  OldDir := '';
  // 先查 HKLM（管理员安装），再查 HKCU（用户级安装，{localappdata} 场景）
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, RegKey, 'Inno Setup: App Path', OldDir) then
    RegQueryStringValue(HKEY_CURRENT_USER, RegKey, 'Inno Setup: App Path', OldDir);

  if OldDir <> '' then
  begin
    Drive := ExtractFileDrive(OldDir);
    if (Drive <> '') and DirExists(Drive + '\') then
    begin
      Log2('检测到历史安装路径，沿用旧路径：' + OldDir);
      Result := OldDir;
      Exit;
    end
    else
    begin
      // 找到了旧记录，但驱动器已离线，将提示文字存入全局变量，由 InitializeWizard 显示为内联标签
      DriveWarnText := '⚠ 检测到历史安装路径 ' + OldDir + ' 的驱动器（' + Drive + '）当前不可用。' + #13#10 +
                        '可能是安装盘（U盘/移动硬盘）未插入、网络盘已断开或分区变化。' + #13#10 +
                        '已自动切换到默认位置，您也可以在上方手动修改。';
      Log2('历史路径驱动器不可用：' + Drive + '，旧路径：' + OldDir + '，已降级为默认路径');
    end;
  end
  else
    Log2('未检测到历史安装记录，使用默认安装路径');

  Result := ExpandConstant('{localappdata}\Programs\FluxNote');
end;

// 初始化安装向导，动态注入提示文字
procedure InitializeWizard();
begin
  // 初始化日志文件（写入 %TEMP%，安装完成后由 ssPostInstall 阶段转移到 {app}）
  InstallLogFile := ExpandConstant('{tmp}\fluxnote_install.log');
  SaveStringToFile(InstallLogFile, '', False); // 清空/创建文件
  Log2('====== FluxNote 安装开始 ======');
  Log2('安装程序版本：{#AppVer}');
  Log2('向导初始化完成');

  // 将目录默认值设为智能读取到的上一次安装路径（驱动器不存在时自动降级到默认路径）
  WizardForm.DirEdit.Text := GetCustomDefaultDir('');

  // 驱动器离线警告标签（仅在检测到旧路径但驱动器不可用时显示）
  DriveWarnLabel := TNewStaticText.Create(WizardForm);
  DriveWarnLabel.Parent := WizardForm.SelectDirPage;
  DriveWarnLabel.WordWrap := True;
  DriveWarnLabel.Font.Color := $004080FF; // 橙色 (BGR: FF8000)
  DriveWarnLabel.Font.Style := [fsBold];

  // 在“选择目标位置”页面（SelectDirPage）创建提示文本
  DirHintLabel := TNewStaticText.Create(WizardForm);
  DirHintLabel.Parent := WizardForm.SelectDirPage;
  
  // 定位到目录输入框的正下方
  DirHintLabel.Left := WizardForm.DirEdit.Left;
  DirHintLabel.Top := WizardForm.DirEdit.Top + WizardForm.DirEdit.Height + 12;
  DirHintLabel.Width := WizardForm.DirEdit.Width;
  DirHintLabel.Height := 40;
  DirHintLabel.WordWrap := True;
  
  // 提示文字内容，稍微带一点颜色（深灰色）以区别于普通描述文字
  DirHintLabel.Font.Color := clGrayText; 
  DirHintLabel.Caption := '建议保持默认的当前用户目录。' + #13#10 + 
                          '若安装到 Program Files 等系统级目录，软件运行和保存数据时可能会遇到权限拒绝问题。';

  // DriveWarnLabel 定位在 DirHintLabel 下方，仅当有警告文字时显示
  DriveWarnLabel.Left := DirHintLabel.Left;
  DriveWarnLabel.Top := DirHintLabel.Top + DirHintLabel.Height + 6;
  DriveWarnLabel.Width := DirHintLabel.Width;
  DriveWarnLabel.Height := 52;
  if DriveWarnText <> '' then
  begin
    DriveWarnLabel.Caption := DriveWarnText;
    DriveWarnLabel.Visible := True;
  end
  else
    DriveWarnLabel.Visible := False;
end;

// 拦截用户点击“下一步”的动作，检测是否选择了系统权限目录
function NextButtonClick(CurPageID: Integer): Boolean;
var
  ChosenDir: String;
begin
  Result := True; // 默认允许进入下一步

  if CurPageID = wpSelectDir then
  begin
    ChosenDir := Lowercase(WizardDirValue); // 获取用户当前填写的路径并转小写
    Log2('用户确认安装目录：' + WizardDirValue);
    
    // 简单检测路径中是否包含敏感的系统文件夹名（仅匹配完整路径段，避免误判用户目录名）
    if (Pos('\PROGRAM FILES\', UpperCase(ChosenDir)) > 0) or (Copy(UpperCase(ChosenDir), Length(ChosenDir) - 14, 15) = '\PROGRAM FILES') or
       (Pos('\WINDOWS\', UpperCase(ChosenDir)) > 0) or (Copy(UpperCase(ChosenDir), Length(ChosenDir) - 7, 8) = '\WINDOWS') then
    begin
      // 弹出警告，如果用户选了“否(IDNO)”，就阻止进入下一步，让其重新选择
      if MsgBox('提示' + #13#10#13#10 +
                '您选择的安装目录属于系统级目录。' + #13#10 +
                '将 FluxNote 安装在此类目录，可能导致笔记无法保存、配置无法修改、无法更新等错误。' + #13#10#13#10 +
                '强烈建议安装到默认的用户目录或其他文件夹。是否要继续安装？', 
                mbConfirmation, MB_YESNO) = IDNO then
      begin
        Log2('用户取消，重新选择安装目录');
        Result := False;
      end
      else
        Log2('用户确认强制安装到系统级目录');
    end;
  end;
end;

function InitializeUninstall(): Boolean;
begin
  // 卸载程序是独立进程，不继承安装时的 InstallLogFile，需在此处重新指定
  InstallLogFile := ExpandConstant('{tmp}\fluxnote_uninstall.log');
  SaveStringToFile(InstallLogFile, '', False); // 清空/创建文件
  Log2('====== FluxNote 卸载初始化 ======');

  DeleteUserData := False;
  Result := False;

  case MsgBox(
    'FluxNote 卸载向导' + #13#10#13#10 +
    '是否同时删除您的个人数据？' + #13#10#13#10 +
    '• 是 = 删除所有笔记、图片、上传文件、配置（彻底清空，不可恢复）' + #13#10 +
    '• 否 = 保留数据（推荐，下次重装还能继续用）' + #13#10#13#10 +
    '点“取消”可中止卸载。',
    mbConfirmation, MB_YESNOCANCEL) of

    IDYES:
      begin
        DeleteUserData := True;
        SaveStringToFile(ExpandConstant('{app}\delete_user_data.flag'), 'delete', False);
        Log2('卸载：用户选择删除所有数据');
        Result := True;
      end;

    IDNO:
      begin
        DeleteUserData := False;
        // 删除任何现有的标志文件，防止之前取消/失败的卸载留下的标志影响当前决定
        DeleteFile(ExpandConstant('{app}\delete_user_data.flag'));
        Log2('卸载：用户选择保留数据');
        Result := True;
      end;

    IDCANCEL:
      begin
        Log2('卸载：用户取消卸载');
        Result := False;
      end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  FlagPath, AppPath: String;
  ResultCode: Integer;
begin
  // 防止 InitializeUninstall 未执行（如静默卸载）导致日志失效
  if InstallLogFile = '' then
  begin
    InstallLogFile := ExpandConstant('{tmp}\fluxnote_uninstall.log');
    SaveStringToFile(InstallLogFile, '', False);
  end;

  if CurUninstallStep = usUninstall then
  begin
    FlagPath := ExpandConstant('{app}\delete_user_data.flag');
    AppPath := ExpandConstant('{app}');
    Log2('====== FluxNote 卸载开始 ======');
    Log2('安装目录：' + AppPath);

    // 只有当用户当前明确选择删除数据且标志文件存在时才执行删除
    if DeleteUserData and FileExists(FlagPath) then
    begin
      Log2('开始清理用户数据...');
      ExecLog('taskkill FluxNote.exe',     'taskkill.exe', '/F /IM FluxNote.exe /T',     '', ResultCode);
      ExecLog('taskkill FluxNoteCore.exe', 'taskkill.exe', '/F /IM FluxNoteCore.exe /T', '', ResultCode);

      ExecLog('attrib data',         'attrib', '-R -S -H "' + AppPath + '\data\*.*" /S /D',     '', ResultCode);
      ExecLog('attrib uploads',      'attrib', '-R -S -H "' + AppPath + '\uploads\*.*" /S /D',  '', ResultCode);
      ExecLog('attrib .env',         'attrib', '-R -S -H "' + AppPath + '\.env"',               '', ResultCode);
      ExecLog('attrib settings.json','attrib', '-R -S -H "' + AppPath + '\settings.json"',      '', ResultCode);

      ExecLog('rmdir data',         'cmd.exe', '/C rmdir /s /q "' + AppPath + '\data"',         '', ResultCode);
      ExecLog('rmdir uploads',      'cmd.exe', '/C rmdir /s /q "' + AppPath + '\uploads"',      '', ResultCode);
      ExecLog('del .env',           'cmd.exe', '/C del /f /q "' + AppPath + '\.env"',           '', ResultCode);
      ExecLog('del settings.json',  'cmd.exe', '/C del /f /q "' + AppPath + '\settings.json"',  '', ResultCode);

      DeleteFile(FlagPath);
      Log2('用户数据清理完成');
    end
    else
      Log2('跳过用户数据删除（用户选择保留数据）');
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    // 仅当用户在卸载向导中明确选择了"删除所有数据"时，才整体清除安装目录；
    // 若用户选择保留数据，跳过此步，{app}\data 及其他用户文件会原样留存。
    //
    // 将清理脚本写入系统 %TEMP%，由独立 cmd 进程在卸载器退出后延迟执行。
    if DeleteUserData then
    begin
      AppPath := ExpandConstant('{app}');
      Log2('卸载后处理：写入延迟清理脚本，将在卸载器退出后删除安装目录');
      SaveStringToFile(ExpandConstant('{%TEMP}\fluxnote_cleanup.bat'),
        '@echo off' + #13#10 +
        'cd /d "%TEMP%"' + #13#10 +
        'timeout /t 3 /nobreak > nul' + #13#10 +
        'rmdir /s /q "' + AppPath + '" 2>nul' + #13#10 +
        '(goto) 2>nul & del "%~f0"', False);
      Exec('cmd.exe',
        '/C start "" /B cmd.exe /C "' + ExpandConstant('{%TEMP}\fluxnote_cleanup.bat') + '"',
        '', SW_HIDE, ewNoWait, ResultCode);
      Log2('====== 卸载完成（含数据清理） ======');
    end
    else
      Log2('====== 卸载完成（数据已保留） ======');
  end;
end;

// 安装完成后启动、等待后端预热，并静默关闭

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppPath, RuntimePath, LogFile, TempLogFile, LowerOutput, TarFlagFile: String;
  OutputText: AnsiString; 
  ResultCode: Integer;
  StartTime, CurrentTime, ElapsedTime: Cardinal;
  TimeoutSec, CheckCounter, EstimatedTarSec, TempPos: Integer;
  Found: Boolean;
  TarProcHandle: THandle;
begin
  if CurStep = ssPostInstall then
  begin
    AppPath := ExpandConstant('{app}');
    RuntimePath := AppPath + '\runtime\FluxNoteCore.exe';
    LogFile := AppPath + '\fluxnote_runtime.log';
    TempLogFile := ExpandConstant('{tmp}\fluxnote_startup_read.log');
    TarFlagFile := ExpandConstant('{tmp}\tar_done.flag');

    // 将日志文件从临时目录迁移到安装目录（此时 {app} 已存在）
    InstallLogFile := AppPath + '\install.log';
    if FileExists(ExpandConstant('{tmp}\fluxnote_install.log')) then
      FileCopy(ExpandConstant('{tmp}\fluxnote_install.log'), InstallLogFile, False);
    Log2('====== 进入安装后处理阶段（ssPostInstall） ======');
    Log2('安装目录：' + AppPath);

    // 初始化进度条：总量设为 1000
    WizardForm.ProgressGauge.Min := 0;
    WizardForm.ProgressGauge.Max := 1000;

    // ====================================================
    // 阶段 1：异步解压 (进度条从 800 走到 870，即 80% -> 87%)
    // ====================================================
    Log2('[阶段1] 开始解压运行环境 runtime.zip...');
    WizardForm.StatusLabel.Caption := '正在解压底层运行环境，这可能需要一点时间...';
    WizardForm.ProgressGauge.Position := 800; // 起点直接设为 80%
    WizardForm.Refresh;

    DeleteFile(TarFlagFile); // 确保没有上次残留的 flag
    ExecLog('解压前终止 FluxNoteCore', 'taskkill.exe', '/F /IM FluxNotecore.exe /T', '', ResultCode);

    // 异步启动 tar 仅做解压；flag 写入和 zip 删除在解压成功后单独处理，避免删除失败污染退出码
    // cmd /C "tar ... && echo 1 > flag" —— 只让 tar 负责解压并在成功后写 flag，删除 zip 是后续最佳努力步骤
    if not Exec('cmd.exe', '/C "tar -xf "' + AppPath + '\runtime.zip" -C "' + AppPath + '" && echo 1 > "' + TarFlagFile + '""', '', SW_HIDE, ewNoWait, ResultCode) then
    begin
      Log2('[阶段1] 错误：解压命令启动失败，退出码：' + IntToStr(ResultCode));
      MsgBox('解压命令启动失败,安装无法继续。错误代码：' + IntToStr(ResultCode), mbError, MB_OK);
      Abort;
    end;
    Log2('[阶段1] 解压进程已启动，PID/ResultCode：' + IntToStr(ResultCode));

    // 若 Exec 返回进程 ID，则取得句柄：用于超时强制终止，也用于提前检测进程意外退出
    TarProcHandle := 0;
    if ResultCode <> 0 then
      TarProcHandle := OpenProcess(PROCESS_TERMINATE or SYNCHRONIZE, False, LongWord(ResultCode));

    StartTime := GetTickCount;
    EstimatedTarSec := 20; // 预估解压时间（秒），U盘/慢速存储可能需要更长时间

    // 循环等待 flag 文件出现，期间平滑推动进度条，设置超时防止无限等待
    // 超时上限设为 300 秒，兼容U盘等慢速存储设备
    while not FileExists(TarFlagFile) do
    begin
      CurrentTime := GetTickCount;
      // GetTickCount 约 49.7 天溢出一次，此处简单处理：溢出后重置起点
      if CurrentTime < StartTime then StartTime := CurrentTime;
      ElapsedTime := CurrentTime - StartTime;

      // 提前失败检测：若 tar/cmd 进程已退出但 flag 尚未出现，说明解压失败
      if TarProcHandle <> 0 then
      begin
        if WaitForSingleObject(TarProcHandle, 0) = WAIT_OBJECT_0 then
        begin
          Log2('[阶段1] 错误：tar 进程已提前退出但未产生 flag 文件，解压失败');
          CloseHandle(TarProcHandle);
          TarProcHandle := 0;
          ExecLog('清理 tar.exe', 'taskkill.exe', '/F /IM tar.exe /T', '', ResultCode);
          DeleteFile(TarFlagFile);
          MsgBox('解压运行环境失败，请检查磁盘空间和权限后重试安装。', mbError, MB_OK);
          Abort;
        end;
      end;

      // 超时检查：硬超时 300 秒，兼顾U盘等慢速设备
      if ElapsedTime > 300000 then
      begin
        Log2('[阶段1] 错误：解压超时（已等待 ' + IntToStr(ElapsedTime div 1000) + ' 秒），中止安装');
        MsgBox('解压运行环境超时，如果您安装在U盘等设备，可能需要多等一小会。若非本情况，可能解压失败，请检查磁盘空间和权限后重试安装。', mbError, MB_OK);

        // 先尝试用句柄终止主进程，再始终用 taskkill 结束 tar/cmd 子进程，确保不留后台进程
        if TarProcHandle <> 0 then
        begin
          Sleep(500);
          TerminateProcess(TarProcHandle, 1);
          CloseHandle(TarProcHandle);
          TarProcHandle := 0;
        end;
        ExecLog('超时终止 tar.exe', 'taskkill.exe', '/F /IM tar.exe /T', '', ResultCode);

        DeleteFile(TarFlagFile); // 清理可能的残留文件
        Abort;
      end;

      // 进度条从 800 推进至 870，跨度为 70；
      // 用 Cardinal 算术防止大 ElapsedTime 乘以 70 溢出 Integer
      if ElapsedTime >= Cardinal(EstimatedTarSec) * 1000 then
        TempPos := 870
      else
        TempPos := 800 + Integer((ElapsedTime * 70) div (Cardinal(EstimatedTarSec) * 1000));
      if TempPos > 870 then TempPos := 870; // 卡在 87% 等待真实解压完毕
      
      WizardForm.ProgressGauge.Position := TempPos;
      WizardForm.Refresh;
      Sleep(200); // 5FPS，降低U盘上 flag 文件频繁查询的开销
    end;
    
    // 解压完成，清理进程句柄和 flag 文件
    if TarProcHandle <> 0 then
    begin
      CloseHandle(TarProcHandle);
      TarProcHandle := 0;
    end;
    DeleteFile(TarFlagFile);
    Log2('[阶段1] runtime.zip 解压完成');

    // 最佳努力删除 runtime.zip；删除失败不中止安装（磁盘空间已用，不影响运行）
    if not DeleteFile(AppPath + '\runtime.zip') then
      Log2('[阶段1] 提示：runtime.zip 删除失败，可手动清理，不影响程序运行')
    else
      Log2('[阶段1] runtime.zip 已清理');


    // ====================================================
    // 阶段 2：开始预热 (从 870 慢慢推到 950，即 87% -> 95%)
    // ====================================================
    Log2('[阶段2] 开始数据库初始化预热...');
    WizardForm.ProgressGauge.Position := 870;
    WizardForm.StatusLabel.Caption := '正在初始化数据库...';
    WizardForm.Refresh;

    DeleteFile(LogFile);
    Found := False;

    if not Exec('cmd.exe', '/C ""' + RuntimePath + '" -u server.py --prewarm"',
         AppPath, SW_HIDE, ewNoWait, ResultCode) then
    begin
      Log2('[阶段2] 错误：无法启动预热进程，退出码：' + IntToStr(ResultCode));
      WizardForm.StatusLabel.Caption := '无法启动初始化进程';
    end
    else
    begin
      TimeoutSec := 20; 
      StartTime := GetTickCount;
      CheckCounter := 0; 
      
      while True do
      begin
        CurrentTime := GetTickCount;
        if CurrentTime < StartTime then StartTime := CurrentTime; 
        ElapsedTime := CurrentTime - StartTime;

        if ElapsedTime > (Cardinal(TimeoutSec) * 1000) then Break;

        WizardForm.ProgressGauge.Position := 870 + ((ElapsedTime * 80) div (Cardinal(TimeoutSec) * 1000));
        WizardForm.Refresh; 

        if (CheckCounter mod 5) = 0 then
        begin
          // 优先以 server.py 写入的 .port 文件作为就绪信号，否则再检查日志中的 0.0.0.0:
          if FileExists(AppPath + '\.port') then
          begin
            Log2('[阶段2] 检测到 .port 文件，预热成功（已等待 ' + IntToStr(ElapsedTime div 1000) + ' 秒）');
            Found := True;
            Break;
          end;
          if FileCopy(LogFile, TempLogFile, False) then
          begin
            if LoadStringFromFile(TempLogFile, OutputText) then
            begin
              LowerOutput := Lowercase(String(OutputText));
              if (Pos('prewarm finished successfully', LowerOutput) > 0) or
                 (Pos('starting production server', LowerOutput) > 0) or
                 (Pos('0.0.0.0:', LowerOutput) > 0) then
              begin
                Log2('[阶段2] 日志中检测到就绪信号，预热成功（已等待 ' + IntToStr(ElapsedTime div 1000) + ' 秒）');
                Found := True;
                Break;
              end;
              if Pos('fatal crash', LowerOutput) > 0 then
              begin
                Log2('[阶段2] 错误：日志中检测到 fatal crash，预热失败');
                Break;
              end;
            end;
          end;
        end;
        
        Inc(CheckCounter); 
        Sleep(100); 
      end;
    end;


    // ====================================================
    // 阶段 3：无论成败，善后处理 (停在 95%，最终到 100%)
    // ====================================================
    Log2('[阶段3] 善后处理：终止预热进程');
    WizardForm.ProgressGauge.Position := 950;
    WizardForm.Refresh;

    ExecLog('善后终止 FluxNoteCore', 'taskkill.exe', '/F /IM FluxNotecore.exe /T', '', ResultCode);

    if Found then
    begin
      Log2('[阶段3] 安装成功，底层环境部署完成');
      WizardForm.StatusLabel.Caption := '底层环境部署完成！';
      WizardForm.ProgressGauge.Position := 1000;
      WizardForm.Refresh;
      Sleep(500);
    end
    else
    begin
      Log2('[阶段3] 警告：数据库初始化超时，但不影响软件运行');
      WizardForm.StatusLabel.Caption := '数据库初始化超时';
      MsgBox('数据库初始化耗时过长。' + #13#10#13#10 +
             '不过不用担心，这通常不会影响软件的运行。' + #13#10 +
             '首次运行 FluxNote 时可能需要更多时间，大约为5-10秒。',
             mbError, MB_OK);
    end;

    // 彻底收尾，进度条拉满
    WizardForm.ProgressGauge.Position := 1000;
    WizardForm.Refresh;
    Log2('====== FluxNote 安装完成，日志保存于：' + InstallLogFile + ' ======');
    Sleep(100);
  end;
end;