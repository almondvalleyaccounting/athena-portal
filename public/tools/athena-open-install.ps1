# Athena desktop opener — install for this Windows user (no admin needed).
#
# Lets Athena open Drive files in their desktop apps (Excel, Adobe, Word…) and
# show folders in File Explorer, through Google Drive for desktop:
#   athena-open://open?p=Individuals&p=Agnew.James&p=TB%202025.xlsx
#   athena-open://show?p=Individuals&p=Agnew.James
# Each p= is one folder or file name below AV.Shared. The handler finds
# "<letter>:\Shared drives\AV.Shared" on this PC and opens the path there, so
# saving writes straight back to Drive.
#
# Safe by construction: it only ever touches paths inside AV.Shared, refuses
# "." and "..", and only opens document types — anything else (a .exe, .bat,
# .lnk…) is shown in File Explorer instead of run. Any website can try an
# athena-open link, so these limits are the control, not the browser.
#
# Install:   irm https://portal.almondvalleyaccounting.co.uk/tools/athena-open-install.ps1 | iex
# Remove:    Remove-Item -Recurse "HKCU:\Software\Classes\athena-open", "$env:LOCALAPPDATA\AthenaOpen"

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'AthenaOpen'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$handler = @'
param([string]$Url)
Add-Type -AssemblyName System.Windows.Forms

function Say([string]$msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'Athena', 'OK', 'Warning') | Out-Null
}
function Reveal([string]$path) {
  if (Test-Path -LiteralPath $path -PathType Leaf) { Start-Process explorer.exe "/select,`"$path`"" }
  else { Start-Process explorer.exe "`"$path`"" }
}

try { $u = [Uri]$Url } catch { Say 'Athena could not read that link.'; exit 1 }
$action = $u.Host.ToLower()
if ($action -ne 'open' -and $action -ne 'show') { Say 'That is not an Athena link.'; exit 1 }

$segs = @()
foreach ($pair in $u.Query.TrimStart('?').Split('&')) {
  if ($pair.StartsWith('p=')) { $segs += [Uri]::UnescapeDataString($pair.Substring(2).Replace('+', ' ')) }
}
if ($segs.Count -eq 0) { Say 'That Athena link has no path.'; exit 1 }

# Drive for desktop writes characters Windows forbids in names as "_".
$invalid = [IO.Path]::GetInvalidFileNameChars()
$clean = @()
foreach ($s in $segs) {
  if ($s -eq '' -or $s -eq '.' -or $s -eq '..') { Say 'That Athena link is not a Drive path.'; exit 1 }
  $clean += (-join ($s.ToCharArray() | ForEach-Object { if ($invalid -contains $_) { '_' } else { $_ } }))
}

$root = $null
foreach ($d in [IO.DriveInfo]::GetDrives()) {
  $c = Join-Path $d.RootDirectory.FullName 'Shared drives\AV.Shared'
  if (Test-Path -LiteralPath $c -PathType Container) { $root = $c; break }
}
if (-not $root) {
  Say "Google Drive for desktop isn't showing AV.Shared on this PC.`n`nOpen Google Drive for desktop, make sure you're signed in, and check that 'Shared drives\AV.Shared' appears in File Explorer."
  exit 1
}

$full = [IO.Path]::GetFullPath((Join-Path $root ($clean -join '\')))
if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { Say 'That path is outside AV.Shared.'; exit 1 }

if (-not (Test-Path -LiteralPath $full)) {
  # Not synced yet, or renamed: show the nearest folder that does exist.
  $near = Split-Path $full -Parent
  while ($near.Length -gt $root.Length -and -not (Test-Path -LiteralPath $near)) { $near = Split-Path $near -Parent }
  Reveal $near
  Say ("Couldn't find this on the PC yet:`n$full`n`nOpened the nearest folder instead. If the file was just added, give Drive for desktop a moment to sync.")
  exit 0
}

if ($action -eq 'show' -or (Test-Path -LiteralPath $full -PathType Container)) { Reveal $full; exit 0 }

$docs = '.xlsx','.xlsm','.xls','.xlsb','.csv','.docx','.docm','.doc','.pptx','.ppt','.pdf','.txt','.rtf',
        '.png','.jpg','.jpeg','.gif','.tif','.tiff','.msg','.eml','.zip'
if ($docs -notcontains [IO.Path]::GetExtension($full).ToLower()) { Reveal $full; exit 0 }

Start-Process -FilePath $full
'@
Set-Content -LiteralPath (Join-Path $dir 'athena-open.ps1') -Value $handler -Encoding UTF8

# A hidden launcher, so no PowerShell window flashes up on every click. Quotes in
# the link are escaped, so the link stays one argument however it was built.
$launcher = @'
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
url = Replace(WScript.Arguments(0), """", "%22")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\athena-open.ps1"" """ & url & """", 0, False
'@
Set-Content -LiteralPath (Join-Path $dir 'athena-open.vbs') -Value $launcher -Encoding ASCII

$key = 'HKCU:\Software\Classes\athena-open'
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Athena desktop opener'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value ("wscript.exe `"" + (Join-Path $dir 'athena-open.vbs') + "`" `"%1`"")

$found = $null
foreach ($d in [IO.DriveInfo]::GetDrives()) {
  $c = Join-Path $d.RootDirectory.FullName 'Shared drives\AV.Shared'
  if (Test-Path -LiteralPath $c -PathType Container) { $found = $c; break }
}
Write-Host ''
Write-Host 'Athena desktop opener installed.' -ForegroundColor Green
if ($found) { Write-Host "AV.Shared found at $found" }
else { Write-Host 'Warning: AV.Shared not found. Check Google Drive for desktop is running and signed in.' -ForegroundColor Yellow }
Write-Host 'The first time you open a file from Athena, Chrome asks to open "Athena desktop opener" - tick "Always allow" and click Open.'
