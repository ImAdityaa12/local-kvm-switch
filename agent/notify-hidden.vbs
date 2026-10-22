' Runs a command with no window, then exits.
'
' Deskflow started by the Deskflow service runs its enter/leave commands in a
' new console window (MSWindowsProcess::startDetachedAsSessionUser), which would
' flash on screen at every switch. wscript.exe has no console, so it runs the
' command hidden instead. Used by agent/src/deskflow/engines.ts.
'
'   wscript.exe //B //Nologo notify-hidden.vbs <program> <args...>
Set args = WScript.Arguments
line = ""
For i = 0 To args.Count - 1
  line = line & """" & args(i) & """ "
Next
CreateObject("WScript.Shell").Run line, 0, False
