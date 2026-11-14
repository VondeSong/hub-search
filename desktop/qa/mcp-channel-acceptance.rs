//! Separate opt-in executable; the personal development application stays open.
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--agent-mcp" {
        // A byte-identical, deliberately named copy injects required-peer startup loss.
        if std::env::current_exe()
            .ok()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .is_some_and(|name| name.ends_with("-failing"))
        {
            eprintln!("Synthetic MCP peer startup failure in the isolated acceptance executable");
            std::process::exit(2);
        }
        if let Err(error) = craft_search_lib::run_agent_mcp_stdio() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else if args.len() == 2 && args[0] == "--isolated-data-root" {
        craft_search_lib::run();
    } else {
        eprintln!("验收程序必须指定独立数据目录；未打开个人应用数据");
        std::process::exit(2);
    }
}
