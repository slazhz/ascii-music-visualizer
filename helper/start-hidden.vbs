' Starts the ACV helper with no window. Used by "install-autostart.bat" (runs at Windows sign-in).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
' Keep the log small: start a fresh one when it passes 5 MB.
logFile = fso.BuildPath(folder, "helper.log")
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then fso.DeleteFile logFile, True
End If
' Node.js must be installed (https://nodejs.org).
If sh.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "The ACV helper needs Node.js. Install it from https://nodejs.org and sign in again.", vbExclamation, "ASCII Music Visualizer"
  WScript.Quit 1
End If
sh.Run "cmd /c node server.js >> helper.log 2>&1", 0, False
