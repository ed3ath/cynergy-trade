' Launch a command with no console window — for scheduled tasks and the
' logon Run key, where cmd.exe would flash a visible window.
' Usage: wscript.exe //B //Nologo run-hidden.vbs <command> [args...]
'
' ponytail: single-argument form only (the command path); pass complex
' arguments by wrapping them in a .cmd file — upgrade to named-arg parsing
' if a second hidden launcher is ever needed.
Set sh = CreateObject("WScript.Shell")
sh.Run """" & WScript.Arguments(0) & """", 0, False
