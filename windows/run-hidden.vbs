' Startet update.ps1 ohne sichtbares Fenster (fuer die Aufgabenplanung und den Autostart)
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\update.ps1"" -Quiet", 0, False
