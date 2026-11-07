// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.iter().any(|value| value == "--agent-mcp") {
        if arguments.len() != 1 {
            eprintln!("本轮MCP传输模式不能与其他参数组合");
            std::process::exit(2);
        }
        if let Err(error) = craft_search_lib::run_agent_mcp_stdio() {
            eprintln!("本轮MCP传输失败：{error}");
            std::process::exit(1);
        }
        return;
    }
    if arguments
        .iter()
        .any(|value| value == "--m1-projection-acceptance")
    {
        if let Err(error) = craft_search_lib::run_m1_projection_acceptance_cli() {
            eprintln!("M1 投影验收未通过：{error}");
            std::process::exit(2);
        }
        return;
    }
    if arguments
        .iter()
        .any(|value| value == "--database-maintenance")
    {
        if let Err(error) = craft_search_lib::run_database_maintenance_cli(&arguments) {
            eprintln!("数据库维护失败：{error}");
            std::process::exit(2);
        }
        return;
    }
    if arguments
        .iter()
        .any(|value| value == "--internal-ocr-worker")
    {
        if arguments.len() != 1 || arguments[0] != "--internal-ocr-worker" {
            eprintln!("OCR 工作进程参数不能与其它启动模式组合");
            std::process::exit(2);
        }
        if let Err(error) = craft_search_lib::run_ocr_worker_stdio() {
            eprintln!("OCR 工作进程失败：{error}");
            std::process::exit(1);
        }
        return;
    }
    let launched_as_mcp = std::env::current_exe()
        .ok()
        .and_then(|path| path.file_stem().map(|stem| stem.to_owned()))
        .and_then(|stem| stem.to_str().map(|stem| stem.to_owned()))
        .is_some_and(|stem| stem.eq_ignore_ascii_case("HubMcpLauncher"));
    let mcp_mode = launched_as_mcp || std::env::args().any(|argument| argument == "--mcp");
    if mcp_mode
        && std::env::args_os().any(|argument| {
            let argument = argument.to_string_lossy();
            argument == "--isolated-data-root"
                || argument.starts_with("--isolated-data-root=")
                || argument == "--isolated-background-workers"
        })
    {
        eprintln!("GUI 隔离启动参数不能与 MCP 模式组合；MCP 请使用 --data-dir");
        std::process::exit(2);
    }
    if mcp_mode {
        if let Err(error) = craft_search_lib::run_hub_mcp_stdio() {
            eprintln!("Hub MCP 启动失败：{error}");
            std::process::exit(1);
        }
    } else {
        craft_search_lib::run()
    }
}
