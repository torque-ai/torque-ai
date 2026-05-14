' torque-watchdog-launcher.vbs — invoke a console program with a hidden
' window so Windows Task Scheduler doesn't pop a bash console every tick.
'
' Usage: wscript.exe torque-watchdog-launcher.vbs <exe> <arg1> [arg2 ...]
'
' Each argument is forwarded verbatim and quoted to survive paths with
' spaces. Returns immediately (does not wait for the spawned process).
'
' The Scheduled Task installer (install-torque-watchdog.ps1) registers
' this VBS launcher under wscript.exe instead of bash.exe so the task
' runs invisibly during interactive logon sessions.

If WScript.Arguments.Count < 2 Then
  WScript.Quit 64
End If

cmd = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

' Run hidden (0), do not wait (False).
CreateObject("Wscript.Shell").Run cmd, 0, False
