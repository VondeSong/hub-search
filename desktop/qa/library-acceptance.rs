#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 || args[0] != "--isolated-data-root" {
        eprintln!("资料库验收程序必须指定独立数据目录；未打开个人应用数据");
        std::process::exit(2);
    }
    craft_search_lib::run();
}
