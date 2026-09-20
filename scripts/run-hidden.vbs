' Launch a command with no console window — for scheduled tasks and the
' logon Run key, where node.exe/cmd.exe would flash a visible window.
' Usage: wscript.exe //B //Nologo run-hidden.vbs <exe> [args...]
Set sh = CreateObject("WScript.Shell")
args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next
sh.Run Trim(args), 0, False
