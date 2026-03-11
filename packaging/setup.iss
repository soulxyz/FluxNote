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
Source: "..\migrations\*"; DestDir: "{app}\migrations"; Flags: ignoreversion recursesubdirs createallsubdirs

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

function OpenProcess(dwDesiredAccess: LongWord; bInheritHandle: LongBool; dwProcessId: LongWord): THandle;
  external 'OpenProcess@kernel32.dll stdcall';

var
  DeleteUserData: Boolean;
  DirHintLabel: TNewStaticText; // 用于在选择目录界面显示的文字标签

// 初始化安装向导，动态注入提示文字
procedure InitializeWizard();
begin
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
    
    // 简单检测路径中是否包含敏感的系统文件夹名（仅匹配完整路径段，避免误判用户目录名）
    if (Pos('\PROGRAM FILES\', UpperCase(ChosenDir)) > 0) or (Right(UpperCase(ChosenDir), 15) = '\PROGRAM FILES') or
       (Pos('\WINDOWS\', UpperCase(ChosenDir)) > 0) or (Right(UpperCase(ChosenDir), 8) = '\WINDOWS') then
    begin
      // 弹出警告，如果用户选了“否(IDNO)”，就阻止进入下一步，让其重新选择
      if MsgBox('提示' + #13#10#13#10 +
                '您选择的安装目录属于系统级目录。' + #13#10 +
                '将 FluxNote 安装在此类目录，可能导致笔记无法保存、配置无法修改、无法更新等错误。' + #13#10#13#10 +
                '强烈建议安装到默认的用户目录或其他文件夹。是否要继续安装？', 
                mbConfirmation, MB_YESNO) = IDNO then
      begin
        Result := False; 
      end;
    end;
  end;
end;

function InitializeUninstall(): Boolean;
begin
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
        Result := True;
      end;

    IDNO:
      begin
        DeleteUserData := False;
        // 删除任何现有的标志文件，防止之前取消/失败的卸载留下的标志影响当前决定
        DeleteFile(ExpandConstant('{app}\delete_user_data.flag'));
        Result := True;
      end;

    IDCANCEL:
      Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  FlagPath, AppPath: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    FlagPath := ExpandConstant('{app}\delete_user_data.flag');
    AppPath := ExpandConstant('{app}');

    // 只有当用户当前明确选择删除数据且标志文件存在时才执行删除
    if DeleteUserData and FileExists(FlagPath) then
    begin
      Exec('taskkill.exe', '/F /IM FluxNote.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('taskkill.exe', '/F /IM FluxNoteCore.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

      Exec('cmd.exe', '/C attrib -R -S -H "' + AppPath + '\data\*.*" /S /D', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('cmd.exe', '/C attrib -R -S -H "' + AppPath + '\uploads\*.*" /S /D', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('cmd.exe', '/C attrib -R -S -H "' + AppPath + '\.env"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('cmd.exe', '/C attrib -R -S -H "' + AppPath + '\settings.json"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

      Exec('cmd.exe', '/C rmdir /s /q "' + AppPath + '\data"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('cmd.exe', '/C rmdir /s /q "' + AppPath + '\uploads"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('cmd.exe', '/C del /f /q "' + AppPath + '\.env"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('cmd.exe', '/C del /f /q "' + AppPath + '\settings.json"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

      DeleteFile(FlagPath);
    end;
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
      SaveStringToFile(ExpandConstant('{%TEMP}\fluxnote_cleanup.bat'),
        '@echo off' + #13#10 +
        'cd /d "%TEMP%"' + #13#10 +
        'timeout /t 3 /nobreak > nul' + #13#10 +
        'rmdir /s /q "' + AppPath + '" 2>nul' + #13#10 +
        '(goto) 2>nul & del "%~f0"', False);
      Exec('cmd.exe',
        '/C start "" /B cmd.exe /C "' + ExpandConstant('{%TEMP}\fluxnote_cleanup.bat') + '"',
        '', SW_HIDE, ewNoWait, ResultCode);
    end;
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

    // 初始化进度条：总量设为 1000
    WizardForm.ProgressGauge.Min := 0;
    WizardForm.ProgressGauge.Max := 1000;

    // ====================================================
    // 阶段 1：异步解压 (进度条从 800 走到 870，即 80% -> 87%)
    // ====================================================
    WizardForm.StatusLabel.Caption := '正在解压底层运行环境，这可能需要一点时间...';
    WizardForm.ProgressGauge.Position := 800; // 起点直接设为 80%
    WizardForm.Refresh; 
    
    DeleteFile(TarFlagFile); // 确保没有上次残留的 flag
    Exec('taskkill.exe', '/F /IM FluxNotecore.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    
    // 异步执行解压，完成后写入 flag 文件；ewNoWait 时 ResultCode 可能为进程 ID，用 OpenProcess 取得句柄以便超时时 TerminateProcess
    if not Exec('cmd.exe', '/C "tar -xf "' + AppPath + '\runtime.zip" -C "' + AppPath + '" && del /q "' + AppPath + '\runtime.zip" && echo 1 > "' + TarFlagFile + '""', '', SW_HIDE, ewNoWait, ResultCode) then
    begin
      MsgBox('解压命令启动失败,安装无法继续。错误代码：' + IntToStr(ResultCode), mbError, MB_OK);
      Abort;
    end;
    
    // 若 Exec 返回进程 ID，则取得句柄以便超时时终止；否则 TarProcHandle=0，超时仅靠 taskkill
    TarProcHandle := 0;
    if ResultCode <> 0 then
      TarProcHandle := OpenProcess(PROCESS_TERMINATE, False, LongWord(ResultCode));

    StartTime := GetTickCount;
    EstimatedTarSec := 8; // 预估解压时间（秒），可根据实际情况微调
    
    // 循环等待 flag 文件出现，期间平滑推动进度条，设置超时防止无限等待
    while not FileExists(TarFlagFile) do
    begin
      CurrentTime := GetTickCount;
      if CurrentTime < StartTime then StartTime := CurrentTime;
      ElapsedTime := CurrentTime - StartTime;

      // 超时检查：如果等待时间超过预估时间的3倍，则认为解压失败
      if ElapsedTime > (Cardinal(EstimatedTarSec) * 3000) then
      begin
        MsgBox('解压运行环境超时，可能解压失败。请检查磁盘空间和权限后重试安装。', mbError, MB_OK);
        
        // 先尝试用句柄终止主进程，再始终用 taskkill 结束 tar/cmd 子进程，确保不留后台进程
        if TarProcHandle <> 0 then
        begin
          Sleep(500);
          TerminateProcess(TarProcHandle, 1);
          CloseHandle(TarProcHandle);
          TarProcHandle := 0;
        end;
        Exec('taskkill.exe', '/F /IM tar.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
        Exec('taskkill.exe', '/F /IM cmd.exe /FI "WINDOWTITLE eq C:\WINDOWS\system32\cmd.exe*" /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
        
        DeleteFile(TarFlagFile); // 清理可能的残留文件
        Abort;
      end;

      // 进度条从 800 推进，跨度为 70
      TempPos := 800 + ((ElapsedTime * 70) div (EstimatedTarSec * 1000));
      if TempPos > 870 then TempPos := 870; // 卡在 87% 等待真实解压完毕
      
      WizardForm.ProgressGauge.Position := TempPos;
      WizardForm.Refresh;
      Sleep(100); // 10FPS 刷新
    end;
    
    // 解压完成，清理进程句柄和 flag 文件
    if TarProcHandle <> 0 then
    begin
      CloseHandle(TarProcHandle);
      TarProcHandle := 0;
    end;
    DeleteFile(TarFlagFile);


    // ====================================================
    // 阶段 2：开始预热 (从 870 慢慢推到 950，即 87% -> 95%)
    // ====================================================
    WizardForm.ProgressGauge.Position := 870; 
    WizardForm.StatusLabel.Caption := '正在初始化数据库...';
    WizardForm.Refresh;

    DeleteFile(LogFile);
    Found := False;

    if not Exec('cmd.exe', '/C ""' + RuntimePath + '" -u server.py --prewarm"',
         AppPath, SW_HIDE, ewNoWait, ResultCode) then
    begin
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
                Found := True;
                Break;
              end;
              if Pos('fatal crash', LowerOutput) > 0 then
                Break;
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
    WizardForm.ProgressGauge.Position := 950; 
    WizardForm.Refresh;

    Exec('taskkill.exe', '/F /IM FluxNotecore.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    if Found then
    begin
      WizardForm.StatusLabel.Caption := '底层环境部署完成！';
      WizardForm.ProgressGauge.Position := 1000; 
      WizardForm.Refresh;
      Sleep(500); 
    end
    else
    begin
      WizardForm.StatusLabel.Caption := '数据库初始化超时';
      MsgBox('数据库初始化耗时过长。' + #13#10#13#10 + 
             '不过不用担心，这通常不会影响软件的运行。' + #13#10 + 
             '首次运行 FluxNote 时可能需要更多时间，大约为5-10秒。', 
             mbError, MB_OK);
    end;
    
    // 彻底收尾，进度条拉满
    WizardForm.ProgressGauge.Position := 1000; 
    WizardForm.Refresh;
    Sleep(100); 
  end;
end;