Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Wscript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)
ps1 = scriptDir & "\collect-dns.ps1"
cmd = "cmd.exe /c cd /d """ & repoRoot & """ && powershell.exe -NoProfile -File """ & ps1 & """"
shell.Run cmd, 0, False