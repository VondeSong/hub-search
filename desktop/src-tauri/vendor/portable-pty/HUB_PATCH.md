# Hub Windows login transport patch

Source: portable-pty 0.9.0, WezTerm commit
`f8921727a11b9f8b073e8c24821d72fd41283500`, directory `pty`.
Upstream: https://github.com/wezterm/wezterm/tree/f8921727a11b9f8b073e8c24821d72fd41283500/pty
Copyright (c) 2018 Wez Furlong; MIT. The complete license is in LICENSE.md.

Only `src/win/psuedocon.rs` is changed: CreatePseudoConsole uses documented
standard flags `0`, instead of the terminal-specific inherit-cursor, resize-quirk
and Win32-input flags. Hub is a Windows GUI process without a parent console.
The upstream flags stalled at the initial cursor query in that process; flags 0
produce normal UTF-8 output and input without an inherited-cursor handshake.
Hub owns a fixed, independently rendered login terminal, so it does not need
parent-console cursor inheritance or Win32-key encoding.

Other source, manifest and license files retain the published upstream contents.
This is a local dependency patch, not an automatic upstream synchronization.
Review the diff and rerun the GUI transport regression before upgrading upstream.
Retire the patch if an upstream API supports selecting standard ConPTY flags.

Regression: scripts/test-tdl-gui-transport.ps1. Real anonymous QR generation is
also checked separately; personal authentication remains a user action.
