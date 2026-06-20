Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Wscript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\collect-dns.ps1"
cmd = "powershell.exe -NoProfile -File """ & ps1 & """"
shell.Run cmd, 0, False