# Manual walk-away verification (live shared sessions)

End-to-end checklist for conversation workers shared by a TUI and a phone.
Run on macOS or Linux with a paired phone and a registered workspace.

1. Open the TUI in the registered workspace (`volt`; it starts the daemon when
   none runs). `volt daemon status` lists one worker for the session, opened
   by `tui`, with one client, and its log under `daemon/workers/`.
2. Pair the phone (`volt remote pair`) and open the same conversation on the
   phone. The TUI footer shows `📱 1`, and the worker reports two clients.
3. Send a prompt from the phone: it appears live in the TUI. Send a prompt
   from the TUI: it appears live on the phone. Open a second terminal with
   `volt -c`: it shows the same conversation, and prompts from it appear in
   both other clients.
4. While a turn streams, quit one TUI. It asks "Stop turn and quit" (the
   default) or "Leave running in background". Leave it running: the turn
   continues, and the phone and the other TUI keep streaming it.
5. Reopen with `volt -c` while a phone turn streams: the TUI attaches to the
   running turn, with the full transcript including turns from while it was
   closed, and its editor accepts input at once.
6. Abort mid-turn from the phone: the turn stops, and every client's stream
   stays connected.
7. `kill -9` the worker's pid (from `volt daemon status`): the TUI shows
   "Reconnecting", the phone reconnects, and both resume on a new worker with
   the saved history; the interrupted turn is lost.
8. `volt daemon stop` with the TUI open: running turns finish (at most 60 s),
   the TUI shows "Host restarting", and after 10 s it starts the daemon itself
   and reconnects. The phone reconnects once the daemon is back; pairing
   survives (no new QR needed).
