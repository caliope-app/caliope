# Installs or updates Caliope for the current Windows user, without admin rights:
#   irm __RELEASES_URL__/latest/download/install.ps1 | iex
# - Each version goes into its own folder under %LOCALAPPDATA%\Programs\Caliope; the newest two are kept.
# - %LOCALAPPDATA%\Programs\Caliope\Caliope.cmd starts the installed version; the Start-menu shortcut uses it.
# - Sessions, settings and the sign-in stay in %LOCALAPPDATA%\Caliope.
# - Run it again to update. Uninstall from Settings > Apps, or run this script with -Uninstall.
# - Downloads go through HTTPS_PROXY when it is set (Caliope sets it from Settings > Network for updates).
# - -NoStart installs without starting Caliope (the release workflow tests the installer that way).
# tools/package.mjs fills in the releases address; set CALIOPE_RELEASES_URL to use another one.
param(
  [string]$Version = 'latest',
  [switch]$Uninstall,
  [switch]$NoStart
)

# The body runs in its own scope: under "irm | iex" it would otherwise leave $ErrorActionPreference and
# its variables behind in the window the install line was pasted into.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  function Stop-Install([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    # A plain "exit" would close the PowerShell window of someone who pasted the install line.
    throw 'Caliope was not installed.'
  }

  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Stop-Install 'PowerShell is restricted on this PC (Constrained Language Mode). Caliope uses PowerShell to save its sign-in, pick folders and run the agent''s commands, so it cannot work here. Ask your IT department.'
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    Stop-Install 'Caliope needs 64-bit Windows.'
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Releases = if ($env:CALIOPE_RELEASES_URL) { $env:CALIOPE_RELEASES_URL.TrimEnd('/') } else { '__RELEASES_URL__' }
  $Asset = 'Caliope-windows-x64.zip'
  $Root = Join-Path $env:LOCALAPPDATA 'Programs\Caliope'
  $Launcher = Join-Path $Root 'Caliope.cmd'
  $Shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Caliope.lnk'
  $UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Caliope'

  if ($Uninstall) {
    # Stop a running Caliope first: its node.exe keeps the version folder from being deleted.
    $ServerFile = Join-Path $env:LOCALAPPDATA 'Caliope\server.json'
    if (Test-Path -LiteralPath $ServerFile) {
      try {
        $Server = Get-Content -LiteralPath $ServerFile -Raw | ConvertFrom-Json
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($Server.port)/shutdown" -Headers @{ 'X-Caliope-Secret' = $Server.secret } -TimeoutSec 5 -UseBasicParsing | Out-Null
        Wait-Process -Id $Server.pid -Timeout 15 -ErrorAction SilentlyContinue
      } catch {
        # Not running, or an older version without /shutdown: the removal below says so if files are in use.
      }
    }
    try {
      Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
    } catch {
      Stop-Install "Some files are still in use. Close Caliope and run the uninstall again. ($($_.Exception.Message))"
    }
    # Only now: if the files could not be removed, Settings > Apps still offers the uninstall.
    Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
    # The desktop shortcut from Settings > App points into the removed folder; one of the user's own stays.
    $DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Caliope.lnk'
    if (Test-Path -LiteralPath $DesktopShortcut) {
      $DesktopTarget = (New-Object -ComObject WScript.Shell).CreateShortcut($DesktopShortcut).TargetPath
      if ($DesktopTarget.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $DesktopShortcut -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item -LiteralPath $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Caliope is uninstalled. Your sessions and settings are still in $env:LOCALAPPDATA\Caliope; delete that folder to remove them too."
    return
  }

  $Web = @{ UseBasicParsing = $true }
  if ($env:HTTPS_PROXY) {
    $Web.Proxy = $env:HTTPS_PROXY
    $Web.ProxyUseDefaultCredentials = $true
  }

  $Base = if ($Version -eq 'latest') { "$Releases/latest/download" } else { "$Releases/download/v$($Version.TrimStart('v'))" }
  Write-Host 'Looking up the Caliope release...'
  $Manifest = Invoke-RestMethod -Uri "$Base/manifest.json" @Web
  $Current = [string]$Manifest.version
  if ($Current -notmatch '^\d+\.\d+\.\d+$') { Stop-Install "The release lists an invalid version ($Current)." }
  $Expected = [string]$Manifest.files.$Asset.sha256
  $Target = Join-Path $Root $Current

  if (Test-Path -LiteralPath (Join-Path $Target 'Caliope.cmd')) {
    Write-Host "Caliope $Current is already installed."
  } else {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $Zip = Join-Path $Root 'Caliope-windows-x64.download.zip'
    Write-Host "Downloading Caliope $Current..."
    Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $Zip @Web
    # .NET instead of Get-FileHash and Expand-Archive: Windows PowerShell started from PowerShell 7 inherits its
    # module path and then has neither.
    $Stream = [System.IO.File]::OpenRead($Zip)
    try {
      $Hash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($Stream)) -replace '-', ''
    } finally {
      $Stream.Dispose()
    }
    if ($Hash -ne $Expected) {
      Remove-Item -LiteralPath $Zip -Force
      Stop-Install 'The download is damaged: its checksum does not match the release. Run the install line again.'
    }
    # Unpack next to the final folder and rename it, so a version folder is never half full.
    $Staging = "$Target.tmp"
    Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Staging)
    Get-ChildItem -LiteralPath $Staging -Recurse -File | Unblock-File
    Rename-Item -LiteralPath $Staging -NewName $Current
    Remove-Item -LiteralPath $Zip -Force
  }

  # The launcher, icon, shortcut and uninstall entry stay in place across updates; only the version changes.
  Set-Content -LiteralPath "$Launcher.tmp" -Value "@call `"%~dp0$Current\Caliope.cmd`" %*" -Encoding Ascii
  Move-Item -LiteralPath "$Launcher.tmp" -Destination $Launcher -Force
  Copy-Item -LiteralPath (Join-Path $Target 'assets\Caliope.ico') -Destination (Join-Path $Root 'Caliope.ico') -Force

  $Shell = New-Object -ComObject WScript.Shell
  $Link = $Shell.CreateShortcut($Shortcut)
  $Link.TargetPath = $Launcher
  $Link.WorkingDirectory = $Root
  $Link.IconLocation = Join-Path $Root 'Caliope.ico'
  $Link.WindowStyle = 7
  $Link.Description = 'Caliope: desktop app for GitHub Copilot'
  $Link.Save()

  New-Item -Path $UninstallKey -Force | Out-Null
  # The uninstall runs this script as a script block, not with -File: a company's execution policy
  # (AllSigned) would block an unsigned script file.
  $UninstallScript = (Join-Path $Target 'install.ps1').Replace("'", "''")
  $Entry = @{
    DisplayName = 'Caliope'
    DisplayVersion = $Current
    Publisher = 'Louis De Geest'
    InstallLocation = $Root
    DisplayIcon = Join-Path $Root 'Caliope.ico'
    UninstallString = "powershell.exe -NoProfile -Command `"& ([scriptblock]::Create([IO.File]::ReadAllText('$UninstallScript'))) -Uninstall`""
  }
  foreach ($Name in $Entry.Keys) { Set-ItemProperty -Path $UninstallKey -Name $Name -Value $Entry[$Name] }
  Set-ItemProperty -Path $UninstallKey -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty -Path $UninstallKey -Name NoRepair -Value 1 -Type DWord

  # Keep the newest two versions and the one just installed (an older one, with -Version). A version that
  # still runs is left alone (deleting it would remove its web files while it serves them); the next update removes it.
  $Running = @(Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ })
  Get-ChildItem -LiteralPath $Root -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -Skip 2 |
    Where-Object { $_.Name -ne $Current } |
    Where-Object { $Folder = "$($_.FullName)\"; -not ($Running | Where-Object { $_.StartsWith($Folder, [StringComparison]::OrdinalIgnoreCase) }) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  if ($NoStart) {
    Write-Host "Caliope $Current is installed. Open it from the Start menu."
    return
  }
  Write-Host "Caliope $Current is installed. Starting it; next time, open Caliope from the Start menu."
  Start-Process -FilePath $Launcher -WindowStyle Minimized
}
