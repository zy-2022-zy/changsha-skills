#ifndef AppVersion
  #define AppVersion "1.1.2"
#endif
#ifndef InstallerGuid
  #define InstallerGuid "698B8D5D-96AF-4B7F-A7AA-2F82C34B8BDD"
#endif
#define InstallerAppId "{{" + InstallerGuid + "}"
#define InstallerUninstallKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\{" + InstallerGuid + "}_is1"
#ifndef ProductName
  #define ProductName "长沙移动系统集团驳回数据Skill"
#endif
#ifndef PayloadDir
  #define PayloadDir "..\build\workbuddy-payload"
#endif
#ifndef OutputPath
  #define OutputPath "..\dist"
#endif
#ifndef LanguageFile
  #define LanguageFile "compiler:Default.isl"
#endif

[Setup]
AppId={#InstallerAppId}
AppName={#ProductName}
AppVersion={#AppVersion}
AppPublisher=长沙移动报备工具
DefaultDirName={code:DefaultSkillDir}
UsePreviousAppDir=no
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputPath}
OutputBaseFilename={#ProductName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UninstallDisplayName={#ProductName}
UninstallDisplayIcon={app}\runtime\node.exe
VersionInfoDescription={#ProductName}
VersionInfoProductName={#ProductName}
VersionInfoVersion={#AppVersion}

[Languages]
Name: "chinesesimp"; MessagesFile: "{#LanguageFile}"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Excludes: ".generated-payload"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{app}\使用说明.txt"; Description: "查看{#ProductName}使用说明"; Flags: shellexec postinstall skipifsilent unchecked

[Messages]
WelcomeLabel2=本安装包将把“{#ProductName}”安装到 WorkBuddy 的技能目录。%n%n内置 Node.js 和所需依赖，无需另外安装 npm 或 pnpm。默认本地浏览器模式需要 Chrome 或 Microsoft Edge；配置云浏览器 CDP 地址后，无需本机安装浏览器。%n%n安装后可在 WorkBuddy 中调用，下载并生成 SEDP 上传文件。
FinishedLabel=技能已安装。请在 WorkBuddy 中刷新技能列表或新建任务，搜索“{#ProductName}”。若未显示，请重新打开 WorkBuddy。

[Code]
var
  PhonePage: TInputQueryWizardPage;
  DownloadPage: TInputDirWizardPage;
  PreviousInstallDir: String;

function ReadPreviousInstallDir: String;
begin
  Result := '';
  RegQueryStringValue(HKCU, '{#InstallerUninstallKey}', 'InstallLocation', Result);
  Result := RemoveBackslashUnlessRoot(Result);
end;

function IsLegacyDir(Directory: String): Boolean;
begin
  { The old identifier is used only for migrating an existing installation. }
  Result := CompareText(ExtractFileName(RemoveBackslashUnlessRoot(Directory)),
    'changsha-mobile-filing-reject') = 0;
end;

function DefaultSkillDir(Param: String): String;
var
  PreviousDir: String;
begin
  PreviousDir := ReadPreviousInstallDir;
  if (PreviousDir <> '') and IsLegacyDir(PreviousDir) and DirExists(PreviousDir) then
    Result := AddBackslash(ExtractFileDir(PreviousDir)) + '{#ProductName}'
  else if (PreviousDir <> '') and
    (CompareText(ExtractFileName(PreviousDir), '{#ProductName}') = 0) then
    Result := PreviousDir
  else
    Result := ExpandConstant('{%USERPROFILE}\.workbuddy\skills\{#ProductName}');
end;

function CanMigrateLegacyDir: Boolean;
var
  Destination: String;
begin
  Destination := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
  Result := (PreviousInstallDir <> '') and DirExists(PreviousInstallDir) and
    IsLegacyDir(PreviousInstallDir) and
    (CompareText(ExtractFileName(Destination), '{#ProductName}') = 0) and
    (CompareText(ExtractFileDir(PreviousInstallDir), ExtractFileDir(Destination)) = 0);
end;

function InitializeSetup: Boolean;
begin
  PreviousInstallDir := ReadPreviousInstallDir;
  Result := True;
end;

function BrowserChannel: String;
var
  BrowserPath: String;
begin
  Result := 'chrome';
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', BrowserPath) then
    if FileExists(BrowserPath) then exit;
  if RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', BrowserPath) then
    if FileExists(BrowserPath) then exit;
  if FileExists(ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe')) or
     FileExists(ExpandConstant('{autopf}\Google\Chrome\Application\chrome.exe')) or
     FileExists(ExpandConstant('{commonpf32}\Google\Chrome\Application\chrome.exe')) then exit;
  if FileExists(ExpandConstant('{commonpf32}\Microsoft\Edge\Application\msedge.exe')) or
     FileExists(ExpandConstant('{autopf}\Microsoft\Edge\Application\msedge.exe')) or
     FileExists(ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe')) then
    Result := 'msedge';
end;

function ValidPhone(Value: String): Boolean;
var
  Index: Integer;
begin
  Result := True;
  if Value = '' then exit;
  Result := False;
  if Length(Value) <> 11 then exit;
  if (Value[1] <> '1') or (Value[2] < '3') or (Value[2] > '9') then exit;
  for Index := 1 to Length(Value) do
    if (Value[Index] < '0') or (Value[Index] > '9') then exit;
  Result := True;
end;

function ConfigExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\.env'));
  if (not Result) and CanMigrateLegacyDir then
    Result := FileExists(AddBackslash(PreviousInstallDir) + '.env');
end;

procedure InitializeWizard;
var
  DefaultDownload: String;
begin
  PhonePage := CreateInputQueryPage(wpSelectDir, '本机登录设置', '填写手机号后，登录时可自动填入。',
    '手机号可留空。登录验证由 Agent 协助完成；如页面要求人机验证或短信验证码，请在聊天窗口按提示提供答案。升级安装会保留已有配置。');
  PhonePage.Add('登录手机号（可选）：', False);
  PhonePage.Values[0] := ExpandConstant('{param:LoginPhone|}');

  if DirExists('D:\') then DefaultDownload := 'D:\报备\集团驳回'
  else DefaultDownload := ExpandConstant('{userdocs}\报备\集团驳回');
  DownloadPage := CreateInputDirPage(PhonePage.ID, '下载文件目录', '驳回结果和 SEDP 文件按日期保存。',
    '请选择保存目录，目录不存在时会自动创建。', False, '');
  DownloadPage.Add('文件保存目录：');
  DownloadPage.Values[0] := ExpandConstant('{param:DownloadDir|' + DefaultDownload + '}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := ((PageID = PhonePage.ID) or (PageID = DownloadPage.ID)) and ConfigExists;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PhonePage.ID then begin
    if not ValidPhone(Trim(PhonePage.Values[0])) then begin
      MsgBox('请输入正确的 11 位手机号，或留空。', mbError, MB_OK);
      Result := False;
    end;
  end;
  if CurPageID = DownloadPage.ID then begin
    if (Trim(DownloadPage.Values[0]) = '') or (ExtractFileDrive(DownloadPage.Values[0]) = '') then begin
      MsgBox('请选择完整的文件保存路径。', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Destination: String;
begin
  Result := '';
  if CanMigrateLegacyDir then begin
    Destination := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
    if DirExists(Destination) then begin
      Result := '新旧技能目录同时存在，无法安全合并。请保留两处数据，选择不存在的新安装目录后重试。';
      exit;
    end;
    { Both absolute paths have been checked to share the same parent directory. }
    if not RenameFile(PreviousInstallDir, Destination) then begin
      Result := '无法将旧版技能目录重命名为中文目录。请关闭正在使用此技能的程序后重试。';
      exit;
    end;
    Log('Migrated the previous skill directory to the new skill name.');
    PreviousInstallDir := '';
  end;
  if ConfigExists then exit;
  if not ValidPhone(Trim(PhonePage.Values[0])) then begin
    Result := '登录手机号格式错误。';
    exit;
  end;
  if (Trim(DownloadPage.Values[0]) = '') or (ExtractFileDrive(DownloadPage.Values[0]) = '') then begin
    Result := '文件保存目录必须是完整路径。';
    exit;
  end;
  if not ForceDirectories(DownloadPage.Values[0]) then
    Result := '无法创建文件保存目录：' + DownloadPage.Values[0];
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Config: String;
begin
  if (CurStep = ssPostInstall) and (not ConfigExists) then begin
    Config := '# WorkBuddy 本机配置，升级安装时会保留。' + #13#10 +
      'LOGIN_PHONE=' + Trim(PhonePage.Values[0]) + #13#10 +
      '# 云浏览器 CDP 地址；留空时使用本地浏览器。' + #13#10 +
      'BROWSER_CDP_URL=' + #13#10 +
      'BROWSER_CDP_CONNECT_TIMEOUT_MS=15000' + #13#10 +
      'BROWSER_CHANNEL=' + BrowserChannel + #13#10 +
      'MOBILE_PORTAL_BASE_URL=https://wap.hn.10086.cn/ismsports/' + #13#10 +
      'DOWNLOAD_DIR=' + DownloadPage.Values[0] + #13#10 +
      'STATE_DIR=reports' + #13#10 +
      'AUTH_DIR=.runtime' + #13#10 +
      'LOGIN_TIMEOUT_MS=600000' + #13#10 +
      'RESULT_POLL_INTERVAL_MS=15000' + #13#10 +
      'RESULT_POLL_TIMEOUT_MS=1800000' + #13#10;
    if not SaveStringToFile(ExpandConstant('{app}\.env'), Utf8Encode(Config), False) then
      RaiseException('无法保存本机配置文件 .env。');
  end;
end;
