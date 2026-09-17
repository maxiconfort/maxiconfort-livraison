' MAXICONFORT — lance l'agent d'impression GLS sans fenetre visible, SEULEMENT s'il ne tourne pas deja.
' Appele par : le raccourci du dossier Demarrage (ouverture de session) ET la tache planifiee
' "Maxiconfort - Impression GLS (surveillance)" toutes les 5 minutes (filet de securite).
Option Explicit
Dim wmi, procs, p, dejaLance
dejaLance = False
Set wmi = GetObject("winmgmts:\\.\root\cimv2")

' L'agent Node tourne ?
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(1, p.CommandLine, "agent-impression.js", vbTextCompare) > 0 Then dejaLance = True
  End If
Next

' Ou bien la boucle de relance (cmd) est vivante (l'agent redemarre dans les 20 s) ?
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='cmd.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(1, p.CommandLine, "lancer-agent.cmd", vbTextCompare) > 0 Then dejaLance = True
  End If
Next

If Not dejaLance Then
  CreateObject("WScript.Shell").Run """C:\Users\moind\maxiconfort-livraison\print-agent\config\lancer-agent.cmd""", 0, False
End If
