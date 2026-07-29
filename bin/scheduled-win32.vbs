Option Explicit

Dim shell
Dim command
Dim exitCode

If WScript.Arguments.Count <> 3 Then
  WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
command = Quote(WScript.Arguments.Item(0)) & " " & _
  Quote(WScript.Arguments.Item(1)) & " " & _
  Quote(WScript.Arguments.Item(2))
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
  Quote = """" & Replace(CStr(value), """", """""") & """"
End Function
