# Windows

This machine runs Windows. `apply_patch` is only recognized when the whole command is exactly one bash heredoc — call the shell tool with `shell: "bash"` and a command that starts with `apply_patch <<'PATCH'` and ends with the closing `PATCH` line:

```
apply_patch <<'PATCH'
*** Begin Patch
*** Update File: path/to/file.py
@@
-old line
+new line
*** End Patch
PATCH
```

- Put nothing else in that command: no `cd`, `mkdir`, `&&`, and no extra line after `PATCH` (run tests or scripts in a separate call). `*** Add File:` creates missing parent folders by itself.
- Never pass a patch through PowerShell (quoted strings, here-strings or pipes all fail), and do not call `apply_patch.bat` or `codex.exe` directly.
- `apply_patch: command not found` means something besides the heredoc was in the command; send the heredoc alone again.
- Use `apply_patch` (not Set-Content, Out-File or redirection) to create, edit and delete files.
