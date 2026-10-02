# Manual walk-away verification (live shared sessions)

End-to-end checklist for the daemon + lease + relay path. Run on macOS or
Linux with a paired phone and a registered workspace.

1. Set `remote.background: true` in `~/.volt/agent/settings.json`. Open the
   TUI in a registered workspace. `volt daemon status` shows the daemon
   running and a `tui-owned` lease for the open session.
2. Pair the phone (`volt remote pair`), open the same conversation on the
   phone. The TUI footer shows `📱 1`.
3. Send a prompt from the phone → it appears live in the TUI. Send a prompt
   from the TUI → it appears live on the phone.
4. Quit the TUI → the phone continues within ~2s (the `lease_transferred`
   closure reconnects silently). Run another full turn from the phone.
5. While a phone turn is streaming, reopen the TUI → "Attaching — finishing
   remote turn…" viewer renders the in-flight turn read-only; typed input
   stays in the editor; the editor unlocks at the turn end with the full
   transcript including away-time turns.
6. Abort mid-turn from the phone → the turn stops, the phone stream stays
   connected (no reconnect spinner), and the TUI keeps streaming events.
7. `volt daemon restart` with the TUI open → the footer phone indicator drops
   and returns; the phone reconnects; pairing survives (no new QR needed).
