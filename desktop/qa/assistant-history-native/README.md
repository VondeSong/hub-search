# 助手历史数据回归

在不安装桌面运行依赖的环境中执行：

```sh
cargo test --manifest-path desktop/qa/assistant-history-native/Cargo.toml --locked
```

该入口直接引用正式 `src-tauri/src/agent_work/store/history.rs` 及其测试，未复制查询或偏好逻辑。覆盖对全部已存对话标题的筛选、跨页排序、游标与筛选绑定、旧偏好兼容、归档与恢复、独立删除/撤销、数据库重新打开和写入失败。

它不加载 Tauri，也不替代完整桌面检查。宿主事务、正在运行的任务与未核对操作保护仍由正式 `store.rs` 执行，对应的集成断言保留在 `agent_work/standalone_tests.rs`，应在具备桌面构建依赖的环境中执行完整 Rust 库测试。
